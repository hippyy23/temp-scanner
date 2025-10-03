import { Component, OnInit } from '@angular/core';
import { BleService } from 'src/services/ble.service';
import { IonHeader, IonToolbar, IonTitle, IonContent, IonButton, IonIcon, IonItem, IonLabel, IonList } from '@ionic/angular/standalone';
import { AsyncPipe } from '@angular/common';
import { addIcons } from 'ionicons';
import { bluetoothOutline, thermometerOutline, stop } from 'ionicons/icons';

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  imports: [IonList, IonLabel, IonItem, IonIcon, IonButton, IonHeader, IonToolbar, IonTitle, IonContent, AsyncPipe],
})
export class HomePage implements OnInit {
  isScanning = false;
  // Make the service public so it can access its devices$ observable
  constructor(public ble: BleService) {
    addIcons({
      bluetoothOutline,
      thermometerOutline,
      stop,
    });
  }

  async ngOnInit() {
    await this.ble.initialize();
  }

  async scan(): Promise<void> {
    if (this.isScanning) {
      await this.stopScan();
    } else {
      await this.startScan();
    }
  }

  private async startScan(): Promise<void> {
    console.log("Starting scan");
    this.isScanning = true;
    await this.ble.startScan();
  }

  private async stopScan(): Promise<void> {
    console.log("Stopping scan");
    this.isScanning = false;
    await this.ble.stopScan();
  }

  ngOnDestroy(): void {
    if (this.isScanning) {
      this.stopScan();
    }
  }
}
