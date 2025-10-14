import { Injectable, NgZone } from "@angular/core";
import { BleClient, ScanResult } from "@capacitor-community/bluetooth-le";
import { BehaviorSubject } from "rxjs";
import { Capacitor } from "@capacitor/core";

export interface TempSensor {
    id: string;
    temperature: number;
    rssi: number; // Signal strength
    name: string;
    lastUpdate: Date;
    status: 'idle' | 'processing' | 'confirmed' | 'failed';
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

    private temperatureUpdateInterval: any;
    private deviceDiscoveryInterval: any;

    // Specific Service UUID from the ESP32
    private readonly SERVICE_UUID = '0000fd6f-0000-1000-8000-00805f9b34fb';
    private readonly ACK_CHAR_UUID = 'a495ff22-c5b1-4b44-b512-1370f02d74de';
    private readonly CONFIRM_CHAR_UUID = 'a495ff23-c5b1-4b44-b512-1370f02d74de';

    constructor(private ngZone: NgZone) {}

    async initialize(): Promise<void> {
        if (Capacitor.getPlatform() === "web") {
            console.log("Running in web environment, skipping native BLE initialization.");
            return;
        }
        
        await BleClient.initialize();
    }

    private startMockDevices(): void {
        console.log("Starting mock BLE devices simulation")

        // Clear any previous devices
        this.deviceMap.clear();
        this.devicesSubject.next([]);

        const mockDeviceIds = ['0x1A', '0X2B', '0X3C'];
        let deviceIndex = 0;

        this.deviceDiscoveryInterval = setInterval(() => {
            if (deviceIndex >= mockDeviceIds.length) {
                clearInterval(this.deviceDiscoveryInterval);
                console.log("All mock devices discovered");
                return;
            }

            const deviceId = mockDeviceIds[deviceIndex];
            const newSensor: TempSensor = {
                id: deviceId,
                temperature: parseFloat((22.5 + Math.random() * 5).toFixed(2)),
                rssi: -50 - Math.floor(Math.random() * 20),
                name: `ESP32_Mock_`,
                lastUpdate: new Date(),
                status: 'confirmed',
            };
            
            this.deviceMap.set(newSensor.id, newSensor);
            
            this.ngZone.run(() => {
                this.devicesSubject.next(Array.from(this.deviceMap.values()));
            });

            console.log(`Discovered device: ${newSensor.name}`);
            deviceIndex++;

        }, 1500);

        // Conintuously update temperature every 2 seconds
        this.temperatureUpdateInterval = setInterval(() => {
            this.updateMockTemperatures();
        }, 2000);
    }

    private updateMockTemperatures(): void {
        if (this.deviceMap.size === 0) return;

        this.deviceMap.forEach((sensor, deviceId) => {
            const change = (Math.random() - 0.5) * 1;
            const newTemp = sensor.temperature + change;

            const clampedTemp = Math.max(18, Math.min(28, newTemp));

            const newRssi = -50 - Math.floor(Math.random() * 20);
            
            const updateSensor: TempSensor = {
                ...sensor,
                temperature: parseFloat(clampedTemp.toFixed(2)),
                rssi: newRssi,
                lastUpdate: new Date(),
            };
            
            this.deviceMap.set(deviceId, updateSensor);
        });

        this.ngZone.run(() => {
            this.devicesSubject.next(Array.from(this.deviceMap.values()));
        });

        console.log("Update mock device temperatures: ", Array.from(this.deviceMap.values()));
    }

    private stopMockDevices(): void {
        if (this.temperatureUpdateInterval) {
            clearInterval(this.temperatureUpdateInterval);
            this.temperatureUpdateInterval = null;
        }

        console.log("Stopped mock BLE devices simulation");
    }

    async startScan(): Promise<void> {
        if (this.isScanning) {
            console.log("Scan already in progress");
            return;
        }

        // Check the platform
        if (Capacitor.getPlatform() === "web") {
            // If we're on the web, run the mock scan
            this.startMockDevices();
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
            this.stopMockDevices();
        } else {
            await BleClient.stopLEScan();
            console.log("Scan stopped");
        }

    }

    private onScanResult(result: ScanResult): void {
        const serviceData = result.serviceData?.[this.SERVICE_UUID];

        if (!serviceData) return;

        this.ngZone.run(() => {
            const temperature = new DataView(serviceData.buffer).getFloat32(0, true);

            const existingDevice = this.deviceMap.get(result.device.deviceId);

            if (existingDevice) {
                const updatedSensor: TempSensor = {
                    ...existingDevice,
                    temperature: parseFloat(temperature.toFixed(2)),
                    rssi: result.rssi ?? -100,
                    lastUpdate: new Date(),
                };
                this.deviceMap.set(result.device.deviceId, updatedSensor);
            } else {
                // Add new device with initial idle state
                const newSensor: TempSensor = {
                    id: result.device.deviceId,
                    temperature: parseFloat(temperature.toFixed(2)),
                    rssi: result.rssi ?? -100,
                    name: result.localName || 'ESP32_Temp',
                    lastUpdate: new Date(),
                    status: 'idle',
                };
                this.deviceMap.set(newSensor.id, newSensor);
            }

            this.updateDevicesList();
        });
    }

    async processSensorTransaction(sensorId: string): Promise<void> {
        const sensor = this.deviceMap.get(sensorId);
        if (!sensor || sensor.status === 'processing') return;

        this.updateDeviceStatus(sensorId, 'processing');

        try {
            // Stop scanning to prepare for connection
            if (this.isScanning) await this.stopScan();

            // Connect to the device
            await BleClient.connect(sensorId, (deviceId) => this.onDisconnect(deviceId));
            console.log(`Connected to ${sensorId}`);

            // Use a Promise to handle the asynchronous notification
            await new Promise<void>(async (resolve, reject) => {
                const transactinTimeout = setTimeout(() => {
                    reject(new Error('Transaction time out after 10 seconds'));
                }, 10000);
                
                // Subscribe to the confirmation characteristic
                await BleClient.startNotifications(
                    sensorId,
                    this.SERVICE_UUID,
                    this.CONFIRM_CHAR_UUID,
                    (value) => {
                        const confirmation = new TextDecoder().decode(value);
                        console.log(`Received confirmation: ${confirmation}`);
                        
                        if (confirmation === 'CONFIRMED_OK') {
                            console.log("Transaction confirmed");
                            clearTimeout(transactinTimeout);
                            this.updateDeviceStatus(sensorId, 'confirmed');
                            setTimeout(() => {
                                // Check if the device still exists and is still 'confirmed'
                                const currentSensor = this.deviceMap.get(sensorId);
                                if (currentSensor && currentSensor.status === 'confirmed') {
                                    this.updateDeviceStatus(sensorId, 'idle');
                                }
                            }, 3000);
                            resolve();
                        }
                    }
                );

                await new Promise(resolve => setTimeout(resolve, 100));

                // After subscribing, send the acknowledgement
                console.log('Sending acknowledgement...');
                const ackMessage = new TextEncoder().encode('ACK_RECEIVED');
                await BleClient.write(sensorId, this.SERVICE_UUID, this.ACK_CHAR_UUID, new DataView(ackMessage.buffer));
            });
        } catch (error) {
            console.error(`Transaction failed for ${sensorId}:`, error);
            this.updateDeviceStatus(sensorId, 'failed');
            setTimeout(() => {
                const currentSensor = this.deviceMap.get(sensorId);
                if (currentSensor && currentSensor.status === 'failed') {
                    this.updateDeviceStatus(sensorId, 'idle');
                }
            }, 3000);
        } finally {
            // Always disconnect to allow the sensor to resume advertising
            console.log(`Disconnecting from ${sensorId}...`);
            await BleClient.disconnect(sensorId).catch(err => console.error('Disconnect failed: ', err));
        }

        console.log("Transaction complete. Resuming continuous scan...");
        await this.startScan();
    }

    private onDisconnect(deviceId: string) {
        console.log(`Device ${deviceId} disconnected by peer`);
        // this.updateDeviceStatus(deviceId, 'idle');
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
    }
}