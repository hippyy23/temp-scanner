import { Injectable, NgZone } from "@angular/core";
import { BleClient, ScanResult } from "@capacitor-community/bluetooth-le";
import { BehaviorSubject } from "rxjs";
import { Capacitor } from "@capacitor/core";

export interface TempSensor {
    id: number;
    temperature: number;
    rssi: number; // Signal strength
    name: string;
    lastUpdate: Date;
}

@Injectable({
    providedIn: 'root',
})
export class BleService {
    private deviceMap = new Map<number, TempSensor>();
    private devicesSubject = new BehaviorSubject<TempSensor[]>([])
    public devices$ = this.devicesSubject.asObservable();

    private isScanning = false;
    private temperatureUpdateInterval: any;
    private deviceDiscoveryInterval: any;

    // Specific Service UUID from the ESP32
    private readonly TEMP_SERVICE_UUID = "0000fd6f-0000-1000-8000-00805f9b34fb";

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

        const mockDeviceIds = [0x1A, 0X2B, 0X3C];
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
                name: `ESP32_Mock_${deviceId.toString(16)}`,
                lastUpdate: new Date(),
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
        this.isScanning = true;

        // Check the platform
        if (Capacitor.getPlatform() === "web") {
            // If we're on the web, run the mock scan
            this.startMockDevices();
            return;
        }

        // If not on the web, start the real scan
        try {
            await BleClient.requestLEScan(
                {
                    services: [this.TEMP_SERVICE_UUID], // Filter for predefined device
                    allowDuplicates: true,
                    scanMode: 2, // Low latency
                },
                (result) => this.onScanResult(result)
            );

            console.log("BLE scan started");

            setTimeout(async () => {
                await this.stopScan();
            }, 10000);
        } catch (error) {
            console.error("Error starting BLE scan: ", error);
            // Handle permissions errors
        }
    }

    async stopScan(): Promise<void> {
        this.isScanning = false;

        if (Capacitor.getPlatform() === "web") {
            this.stopMockDevices();
        } else {
            await BleClient.stopLEScan();
            console.log("Scan stopped");
        }

        // this.deviceMap.clear();
        // this.devicesSubject.next([]);
    }

    private onScanResult(result: ScanResult): void {
        console.log("=== BLE DEVICE FOUND ===");
        console.log("Name:", result.localName);
        console.log("RSSI:", result.rssi);
        console.log("All UUIDs:", result.uuids);
        console.log("All Service Data keys:", result.serviceData ? Object.keys(result.serviceData) : "None");


        if (!result.serviceData || !result.serviceData[this.TEMP_SERVICE_UUID]) {
            return;
        }

        console.log("Found device: ", result.localName, "RSSI: ", result.rssi);

        const serviceData = new DataView(result.serviceData[this.TEMP_SERVICE_UUID].buffer);

        if (serviceData.byteLength < 5) return;

        const deviceId = serviceData.getUint8(0);
        const temperature = serviceData.getFloat32(1, true);

        const sensor: TempSensor = {
            id: deviceId,
            temperature: parseFloat(temperature.toFixed(2)),
            rssi: result.rssi || -1,
            name: result.localName || `ESP32_${deviceId.toString(16)}`,
            lastUpdate: new Date(),
        };

        // const mockSensor: TempSensor = {
        //     id: Math.random() * 1000,
        //     temperature: parseFloat((20 + Math.random() * 10).toFixed(2)),
        //     rssi: result.rssi || -50,
        //     name: result.localName || `ESP32_${Math.random().toString(16)}`,
        //     lastUpdate: new Date(),
        // }

        this.ngZone.run(() => {
            this.deviceMap.set(sensor.id, sensor);
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