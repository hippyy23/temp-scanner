import { Component, OnInit } from '@angular/core';
import { BleService, TempSensor } from 'src/services/ble.service';
import { IonHeader, IonToolbar, IonTitle, IonContent, IonButton, IonIcon, IonItem, IonLabel, IonList, IonSpinner } from '@ionic/angular/standalone';
import { AsyncPipe, DatePipe } from '@angular/common';
import { addIcons } from 'ionicons';
import { bluetoothOutline, thermometerOutline, stopOutline, checkmarkOutline } from 'ionicons/icons';

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  imports: [IonList, IonLabel, IonItem, IonIcon, IonButton, IonHeader, IonToolbar, IonTitle, IonContent, IonSpinner, AsyncPipe, DatePipe],
})
export class HomePage implements OnInit {
  isScanning = false;
  // Make the service public so it can access its devices$ observable
  constructor(public ble: BleService) {
    addIcons({
      bluetoothOutline,
      thermometerOutline,
      stopOutline,
      checkmarkOutline,
    });
  }

  async ngOnInit() {
    await this.ble.initialize();
  }

  toggleScan(): void {
    if (!this.isScanning) {
      this.isScanning = true;
      this.ble.startScan();
    } else {
      this.isScanning = false;
      this.ble.stopScan();
    }
  }

  acknowledge(sensorId: string): void {
    console.log(`UI requesting acknowledgement for sensor: ${sensorId}`);
    this.ble.processSensorTransaction(sensorId);
  }

  getStatusColor(status: TempSensor['status']): string | undefined {
    switch (status) {
      case 'processing':
        return 'light';
      case 'confirmed':
        return 'success';
      case 'failed':
        return 'danger';
      default:
        return undefined;
    }
  }

  ngOnDestroy(): void {
    if (this.isScanning) {
      this.ble.stopScan();
    }
  }
}
