package asia.junweirpa.piconsole.mobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import asia.junweirpa.piconsole.mobile.ui.MobileApp
import asia.junweirpa.piconsole.mobile.ui.PiConsoleTheme

class MainActivity : ComponentActivity() {
    private val vm: MainViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        setContent {
            PiConsoleTheme {
                MobileApp(vm)
            }
        }
    }
}