import { AirGapAngularCoreModule } from '@airgap/angular-core'
import { CommonModule } from '@angular/common'
import { NgModule } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { RouterModule } from '@angular/router'
import { IonicModule } from '@ionic/angular'
import { TranslateModule } from '@ngx-translate/core'
import { ZXingScannerModule } from '@zxing/ngx-scanner'

import { BitcoinMultisigPage } from './bitcoin-multisig.page'

@NgModule({
  imports: [CommonModule, FormsModule, IonicModule, TranslateModule, AirGapAngularCoreModule, ZXingScannerModule,
    RouterModule.forChild([{ path: '', component: BitcoinMultisigPage }])],
  declarations: [BitcoinMultisigPage]
})
export class BitcoinMultisigPageModule {}
