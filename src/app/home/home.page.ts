import { Component, OnInit } from '@angular/core';
import { BleService, TempSensor } from 'src/services/ble.service';
import { 
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonButton,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonSpinner,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonCardSubtitle,
  IonNote,
} from '@ionic/angular/standalone';
import { AsyncPipe, DatePipe, DecimalPipe } from '@angular/common';
import { addIcons } from 'ionicons';
import {
  bluetoothOutline,
  thermometerOutline,
  stopOutline,
  checkmarkOutline,
  logInOutline,
  logOutOutline,
  closeCircleOutline,
  timeOutline,
  waterOutline,
  flashOutline,
  repeatOutline,
  hardwareChipOutline,
  documentTextOutline,
} from 'ionicons/icons';

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  imports: [IonList, IonLabel, IonItem, IonCard, IonCardHeader, IonCardTitle, IonCardSubtitle, IonCardContent, IonNote, IonListHeader,
            IonIcon, IonButton, IonHeader, IonToolbar, IonTitle, IonContent, IonSpinner, AsyncPipe, DatePipe, DecimalPipe],
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
      logInOutline,
      logOutOutline,
      closeCircleOutline,
      timeOutline,
      waterOutline,
      flashOutline,
      repeatOutline,
      hardwareChipOutline,
      documentTextOutline
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

  getStatusColor(status: TempSensor['status']): string | undefined {
    switch (status) {
      case 'processing':
        return 'light';
      case 'connected':
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
