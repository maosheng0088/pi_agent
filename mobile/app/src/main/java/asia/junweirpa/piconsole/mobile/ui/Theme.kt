package asia.junweirpa.piconsole.mobile.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val BrandBlue = Color(0xFF3466EB)
val BrandBlueSoft = Color(0xFFEDF2FE)
val AppBackground = Color(0xFFF4F6FB)
val InkStrong = Color(0xFF1B2D49)
val InkMuted = Color(0xFF64748B)
val Hairline = Color(0xFFE3E8F0)

private val LightScheme = lightColorScheme(
    primary = BrandBlue,
    onPrimary = Color.White,
    primaryContainer = BrandBlueSoft,
    onPrimaryContainer = BrandBlue,
    secondary = InkMuted,
    onSecondary = Color.White,
    background = AppBackground,
    onBackground = InkStrong,
    surface = Color.White,
    onSurface = InkStrong,
    surfaceVariant = Color(0xFFF1F4F9),
    onSurfaceVariant = InkMuted,
    outline = Hairline,
    error = Color(0xFFD64545),
)

private val DarkScheme = darkColorScheme(
    primary = Color(0xFF8FABFF),
    onPrimary = Color(0xFF0B1730),
    primaryContainer = Color(0xFF1B2F63),
    onPrimaryContainer = Color(0xFFCBD8FF),
    background = Color(0xFF0E1522),
    onBackground = Color(0xFFE6ECF5),
    surface = Color(0xFF17202E),
    onSurface = Color(0xFFE6ECF5),
    surfaceVariant = Color(0xFF1E2836),
    onSurfaceVariant = InkMuted,
    outline = Color(0xFF2B3646),
    error = Color(0xFFFF8A80),
)

@Composable
fun PiConsoleTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (dark) DarkScheme else LightScheme, content = content)
}