import { Injectable, NgZone } from "@angular/core";
import { BleClient, ScanResult } from "@capacitor-community/bluetooth-le";
import { BehaviorSubject } from "rxjs";
import { Capacitor } from "@capacitor/core";
import { Preferences } from '@capacitor/preferences';

// Define the SensorData interface that corresponds to the binary struct
export interface SensorData {
    producedBy: string;
    relayedBy: string;
    measureCount: number;
    measuredAt: Date;
    temperature: number;
    humidity: number;
    stateOfEnergy: number;
}

export interface TempSensor {
    id: string;
    name: string;
    rssi: number; // Signal strength
    lastUpdate: Date;
    status: 'idle' | 'processing' | 'connected' | 'failed';
    sensorData?: SensorData[];
}

@Injectable({
    providedIn: 'root',
})
export class BleService {
    private deviceMap = new Map<string, TempSensor>();
    private devicesSubject = new BehaviorSubject<TempSensor[]>([])
    public devices$ = this.devicesSubject.asObservable();
    private isScanning = false;
    private scanTimeout: any;

    // Specific Service UUID from the ESP32
    private readonly SERVICE_UUID = '0000fd6f-0000-1000-8000-00805f9b34fb';
    private readonly ACK_CHAR_UUID = 'a495ff22-c5b1-4b44-b512-1370f02d74de';
    private readonly CONFIRM_CHAR_UUID = 'a495ff23-c5b1-4b44-b512-1370f02d74de';
    private readonly DATA_CHAR_UUID = 'a495ff24-c5b1-4b44-b512-1370f02d74de';

    // State management
    private connectedDeviceIdSubject: BehaviorSubject<string | null> = new BehaviorSubject<string | null>(null);
    public connectedDeviceId$ = this.connectedDeviceIdSubject.asObservable();
    private pendingAckIds = new Set<number>();
    private sentAckIds = new Set<number>();
    private readonly ACK_STORAGE_KEY = 'pendingAcks';

    constructor(private ngZone: NgZone) {
        this.loadPendingAcks();
    }

    // Persistent ACK storage
    private async loadPendingAcks() {
        try {
            const { value } = await Preferences.get({ key: this.ACK_STORAGE_KEY });
            if (value) {
                this.pendingAckIds = new Set(JSON.parse(value));
                console.log(`Loaded ${this.pendingAckIds.size} pending acks from storage`);
            }
        } catch (e) {
            console.error("Could not load pending ACKs: ", e);
        }
    }

    private async savePendingAcks() {
        try {
            await Preferences.set({ key: this.ACK_STORAGE_KEY, value: JSON.stringify(Array.from(this.pendingAckIds)) });
        } catch (e) {
            console.error("Could not save pending ACKs: ", e);
        }
    }

    async initialize(): Promise<void> {
        if (Capacitor.getPlatform() === "web") {
            console.log("Running in web environment, skipping native BLE initialization.");
            return;
        }
        
        await BleClient.initialize();
    }

    async startScan(): Promise<void> {
        if (this.isScanning) {
            console.log("Scan already in progress");
            return;
        }

        // Check the platform
        if (Capacitor.getPlatform() === "web") {
            // If we're on the web
            console.log("Running in web environment.");
            return;
        }

        this.isScanning = true;
        console.log("Continuous scan started");
        this.scanLoop();
    }

    private async scanLoop(): Promise<void> {
        if (!this.isScanning) return;

        try {
            console.log("Starting scan burst...");

            await BleClient.requestLEScan(
                {
                    services: [this.SERVICE_UUID],
                    allowDuplicates: true,
                },
                (result) => this.onScanResult(result)
            );

            this.scanTimeout = setTimeout(async () => {
                console.log("Stopping scan burst...");
                await BleClient.stopLEScan();

                this.scanTimeout = setTimeout(() => this.scanLoop(), 2500);
            }, 2500);

        } catch (error) {
            console.error("Error during scan burst: ", error);
            this.stopScan();
        }
    }

    async stopScan(): Promise<void> {
        if (!this.isScanning) return;

        console.log("Stopping continuous scan...");

        if (this.scanTimeout) {
            clearTimeout(this.scanTimeout);
            this.scanTimeout = null;
        }

        this.isScanning = false;

        if (Capacitor.getPlatform() === "web") {
            console.log("Scan stopped");
        } else {
            await BleClient.stopLEScan();
            console.log("Scan stopped");
        }

    }

    private onScanResult(result: ScanResult): void {
        this.ngZone.run(() => {
            const existingDevice = this.deviceMap.get(result.device.deviceId);

            if (!existingDevice) {
                const newSensor: TempSensor = {
                    id: result.device.deviceId,
                    name: result.localName || 'ESP32_Sensor',
                    rssi: result.rssi ?? -100,
                    lastUpdate: new Date(),
                    status: 'idle',
                    sensorData: [],
                };
                this.deviceMap.set(result.device.deviceId, newSensor);
            } else {
                existingDevice.rssi = result.rssi ?? -100;
                existingDevice.lastUpdate = new Date();
            }

            this.updateDevicesList();
        });
    }

    async connectToSensor(sensorId: string): Promise<void> {
        const sensor = this.deviceMap.get(sensorId);

        if (this.connectedDeviceIdSubject.value || !sensor) return;

        try {
            this.updateDeviceStatus(sensorId, 'processing');
            await this.stopScan();

            await BleClient.connect(sensorId, (deviceId) => this.onDisconnect(deviceId));

            this.connectedDeviceIdSubject.next(sensorId);
            this.updateDeviceStatus(sensorId, 'connected');

            sensor.sensorData = [];
            this.updateDevicesList();

            // Subscribe to the final confirmation from the sensor
            await BleClient.startNotifications(
                sensorId, this.SERVICE_UUID, this.CONFIRM_CHAR_UUID,
                (value) => {
                    const confirmation = new TextDecoder().decode(value);

                    if (confirmation === 'CONFIRMED_OK') {
                        console.log("Received final ACK confirmation form sensor");
                        this.sentAckIds.forEach(id => this.pendingAckIds.delete(id));
                        this.savePendingAcks();
                        this.sentAckIds.clear();
                    }
                }
            );

            // Subscribe to the data channel
            await BleClient.startNotifications(
                sensorId, this.SERVICE_UUID, this.DATA_CHAR_UUID,
                (value) => {
                    const jsonString = new TextDecoder().decode(value);

                    try {
                        const data: SensorData = JSON.parse(jsonString);
                        console.log("Received sensor data: ", data.measureCount);

                        // Add the new data to UI
                        this.ngZone.run(() => {
                            if (sensor.sensorData) {
                                sensor.sensorData.push(data);
                            } else {
                                sensor.sensorData = [data];
                            }
                            this.updateDevicesList();
                        });

                        // Add ID to pending list and save
                        this.pendingAckIds.add(data.measureCount);
                        this.savePendingAcks();

                       this.sendPendingAcks(); 
                    } catch (e) {
                        console.error("Error parsing sensor data: ", e);
                    }
                }
            );

            // Send all pending ACKs
            await this.savePendingAcks();

        } catch (error) {
            console.error(`Failed to connect to ${sensorId}: ${error}`);
            this.updateDeviceStatus(sensorId, 'failed');
            this.onDisconnect(sensorId);
        }
    }

    private async sendPendingAcks(): Promise<void> {
        const connectedId = this.connectedDeviceIdSubject.value;

        if (this.pendingAckIds.size === 0 || !connectedId) {
            if (this.pendingAckIds.size === 0) console.log("No pending ACKs to send");
            return;
        }

        try {
            const idsToAck = Array.from(this.pendingAckIds);
            this.sentAckIds = new Set(idsToAck);

            const ackPayload = { acks: idsToAck };
            const ackMessage = JSON.stringify(ackPayload);
            const encodedMessage = new TextEncoder().encode(ackMessage);

            await BleClient.write(
                connectedId,
                this.SERVICE_UUID,
                this.ACK_CHAR_UUID,
                new DataView(encodedMessage.buffer)
            );

            console.log(`Sent batch ACK for ${idsToAck.length} packets`);
        } catch (error) {
            console.error("Failed to send batch ACK: ", error);
        }
    }

    async disconnect(): Promise<void> {
        const connectedId = this.connectedDeviceIdSubject.value;
        if (!connectedId) return;

        try {
            await BleClient.disconnect(connectedId);
        } catch (error) {
            console.error("Failed to disconnect: ", error);
        }
    }

    private onDisconnect(deviceId: string) {
        console.log(`Device ${deviceId} disconnected`);
        this.connectedDeviceIdSubject.next(null);
        this.updateDeviceStatus(deviceId, 'idle');
        this.sentAckIds.clear();

        this.startScan();
    }

    private updateDeviceStatus(sensorId:string, status: TempSensor['status']) {
        if (this.deviceMap.has(sensorId)) {
            this.deviceMap.get(sensorId)!.status = status;
            this.updateDevicesList();
        }
    }

    private updateDevicesList() {
        this.ngZone.run(() => {
            this.devicesSubject.next(Array.from(this.deviceMap.values()));
        });
    }

    getScanningStatus(): boolean {
        return this.isScanning;
    }

    ngOnDestroy(): void {
        this.stopScan();
        if (this.connectedDeviceIdSubject.value) {
            this.disconnect();
        }
    }
}