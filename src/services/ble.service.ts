import { Injectable, NgZone, REQUEST } from "@angular/core";
import { BleClient, ScanResult } from "@capacitor-community/bluetooth-le";
import { BehaviorSubject, bufferToggle } from "rxjs";
import { Capacitor } from "@capacitor/core";
import { Preferences } from '@capacitor/preferences';

// Define the SensorData interface that corresponds to the binary struct
export interface SensorData {
    producedBy: string;
    relayedBy: string;
    measureCount: number;
    measuredAt: number;
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
    lastKnownMeasureCount: number;
    isCollecting?: boolean;
}

const OPCODE = {
    REQUEST_DATA: 0x01,
    START_COLLECTING: 0x03,
    STOP_COLLECTING: 0x04,
};

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
    private readonly DATA_CHAR_UUID = 'a495ff22-c5b1-4b44-b512-1370f02d74de';
    private readonly COMMAND_CHAR_UUID = 'a495ff23-c5b1-4b44-b512-1370f02d74de';
    private readonly TIME_SYNC_CHAR_UUID = 'a495ff24-c5b1-4b44-b512-1370f02d74de';
    private readonly STATUS_CHAR_UUID = 'a495ff25-c5b1-4b44-b512-1370f02d74de';

    // State management
    private connectedDeviceIdSubject: BehaviorSubject<string | null> = new BehaviorSubject<string | null>(null);
    public connectedDeviceId$ = this.connectedDeviceIdSubject.asObservable();

    private deviceSettingsMap = new Map<string, { lastKnownMeasureCount: number }>();
    private readonly SETTINGS_STORAGE_KEY = 'deviceSettings';

    constructor(private ngZone: NgZone) {
        this.loadDeviceSettings();
    }

    // Persistent storage
    private async loadDeviceSettings() {
        try {
            const { value } = await Preferences.get({ key: this.SETTINGS_STORAGE_KEY });
            if (value) {
                this.deviceSettingsMap = new Map(Object.entries(JSON.parse(value)));
                console.log(`Loaded device settings for ${this.deviceSettingsMap.size} devices`);
            }
        } catch (e) {
            console.error("Could not load device settings: ", e);
        }
    }

    private async saveDeviceSettings() {
        try {
            // Convert Map to plain object
            const settingsObject = Object.fromEntries(this.deviceSettingsMap);
            await Preferences.set({
                key: this.SETTINGS_STORAGE_KEY,
                value: JSON.stringify(settingsObject),
            });
        } catch (e) {
            console.error("Could not save device settings: ", e);
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

            // Get last known count from persistent storage
            const settings = this.deviceSettingsMap.get(result.device.deviceId) || { lastKnownMeasureCount: 0 };

            if (!existingDevice) {
                const newSensor: TempSensor = {
                    id: result.device.deviceId,
                    name: result.localName || 'ESP32_Sensor',
                    rssi: result.rssi ?? -100,
                    lastUpdate: new Date(),
                    status: 'idle',
                    sensorData: [],
                    lastKnownMeasureCount: settings.lastKnownMeasureCount,
                    isCollecting: undefined,
                };
                this.deviceMap.set(result.device.deviceId, newSensor);
            } else {
                existingDevice.rssi = result.rssi ?? -100;
                existingDevice.lastUpdate = new Date();
                existingDevice.lastKnownMeasureCount = settings.lastKnownMeasureCount;
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

            // --- PROTOCOL FLOW ---

            // Read the current collection status
            console.log("Reading sensor status...");
            const statusValue = await BleClient.read(sensorId, this.SERVICE_UUID, this.STATUS_CHAR_UUID);
            this.updateSensorCollectingStatus(sensor, statusValue.getUint8(0) === 1);

            // Sync clock (automatic)
            await this.syncClock(sensorId);

            // Subscribe to data notifications
            await BleClient.startNotifications(
                sensorId, this.SERVICE_UUID, this.DATA_CHAR_UUID,
                (value) => {
                    const jsonString = new TextDecoder().decode(value);
                    
                    try {
                        const data: SensorData = JSON.parse(jsonString);
                        console.log("Received sensor data: ", data.measureCount);

                        data.measuredAt = data.measuredAt * 1000;

                        this.ngZone.run(() => {
                            if (sensor.sensorData) {
                                sensor.sensorData.push(data);
                            } else {
                                sensor.sensorData = [data];
                            }
                            sensor.lastKnownMeasureCount = Math.max(sensor.lastKnownMeasureCount, data.measureCount);
                            this.deviceSettingsMap.set(sensorId, { lastKnownMeasureCount: sensor.lastKnownMeasureCount });
                            this.saveDeviceSettings();

                            this.updateDevicesList();
                        });
                    } catch (e) {
                        console.error("Failed to parse incoming JSON: ", e);
                    }
                }
            );

            // Subscribe to status notifications
            await BleClient.startNotifications(
                sensorId, this.SERVICE_UUID, this.STATUS_CHAR_UUID,
                (value) => {
                    console.log("Received status update notifications");
                    this.updateSensorCollectingStatus(sensor, value.getUint8(0) === 1);
                }
            );

        } catch (error) {
            console.error(`Failed to connect to ${sensorId}: ${error}`);
            this.updateDeviceStatus(sensorId, 'failed');
            this.onDisconnect(sensorId);
        }
    }

    private updateSensorCollectingStatus(sensor: TempSensor, isCollecting: boolean) {
        this.ngZone.run(() => {
            sensor.isCollecting = isCollecting;
            console.log(`Sensor isCollecting set to: ${isCollecting}`);
            this.updateDevicesList();
        })
    }

    /**
     * Sends the current time to the sensor
     */
    private async syncClock(sensorId: string): Promise<void> {
        try {
            const timestamp_s = Math.floor(Date.now() / 1000);

            const buffer = new ArrayBuffer(4);
            const view = new DataView(buffer);
            view.setUint32(0, timestamp_s, true); // true = littleEndian

            await BleClient.write(
                sensorId,
                this.SERVICE_UUID,
                this.TIME_SYNC_CHAR_UUID,
                view
            );
        } catch (error) {
            console.error("Failed to sync clock: ", error);
        }
    }

    /**
     * Sends the data request command to the sensor 
     */
    public async requestData(sensorId:string, lastKnownId: number): Promise<void> {
        try {
            const buffer = new ArrayBuffer(5);
            const view = new DataView(buffer);
            view.setUint8(0, OPCODE.REQUEST_DATA);
            view.setUint32(1, lastKnownId, true); // true = littleEndian

            await BleClient.write(
                sensorId,
                this.SERVICE_UUID,
                this.COMMAND_CHAR_UUID,
                view
            );
            console.log(`Requested data since packet #${lastKnownId}`);
        } catch (error) {
            console.error("Failed to request data: ", error);
        }
    }

    async sendStartCommand(sensorId: string): Promise<void> {
        const buffer = new ArrayBuffer(1);
        new DataView(buffer).setUint8(0, OPCODE.START_COLLECTING);
        await BleClient.write(sensorId, this.SERVICE_UUID, this.COMMAND_CHAR_UUID, new DataView(buffer));
    }

    async sendStopCommand(sensorId: string): Promise<void> {
        const buffer = new ArrayBuffer(1);
        new DataView(buffer).setUint8(0, OPCODE.STOP_COLLECTING);
        await BleClient.write(sensorId, this.SERVICE_UUID, this.COMMAND_CHAR_UUID, new DataView(buffer));
    }

    async disconnect(): Promise<void> {
        const connectedId = this.connectedDeviceIdSubject.value;
        if (!connectedId) return;

        try {
            await BleClient.stopNotifications(connectedId, this.SERVICE_UUID, this.DATA_CHAR_UUID);
            await BleClient.stopNotifications(connectedId, this.SERVICE_UUID, this.STATUS_CHAR_UUID);
            await BleClient.disconnect(connectedId);
        } catch (error) {
            console.error("Failed to disconnect: ", error);
        }
    }

    private onDisconnect(deviceId: string) {
        console.log(`Device ${deviceId} disconnected`);
        this.connectedDeviceIdSubject.next(null);
        this.updateDeviceStatus(deviceId, 'idle');

        const sensor = this.deviceMap.get(deviceId);
        if (sensor) {
            this.updateSensorCollectingStatus(sensor, false);
        }

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