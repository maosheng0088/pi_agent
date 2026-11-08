package asia.junweirpa.piconsole.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Dns
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material.icons.filled.Person
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import asia.junweirpa.piconsole.mobile.MainViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProfileScreen(vm: MainViewModel, padding: PaddingValues) {
    var showPassword by remember { mutableStateOf(false) }
    Scaffold(
        modifier = Modifier.padding(padding),
        topBar = { TopAppBar(title = { Text("我的", fontWeight = FontWeight.Bold) }) },
    ) { inner ->
        Column(
            Modifier
                .padding(inner)
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            val account = vm.account
            Card(
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier.size(52.dp).clip(RoundedCornerShape(16.dp)).background(BrandBlue),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.Default.Person, null, tint = Color.White)
                    }
                    Spacer(Modifier.width(14.dp))
                    Column {
                        Text(
                            account?.displayName?.ifBlank { account.username } ?: "未登录",
                            fontWeight = FontWeight.SemiBold,
                            fontSize = 17.sp,
                        )
                        Spacer(Modifier.height(2.dp))
                        Text(
                            listOfNotNull(
                                account?.username?.takeIf { it.isNotBlank() },
                                if (account?.role == "admin") "管理员" else "员工",
                            ).joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            InfoRow(Icons.Default.Dns, "服务器地址", vm.serverUrl)
            OutlinedButton(onClick = { showPassword = true }, modifier = Modifier.fillMaxWidth()) {
                Text("修改密码")
            }
            OutlinedButton(onClick = { vm.logout() }, modifier = Modifier.fillMaxWidth()) {
                Icon(Icons.Default.Logout, null)
                Spacer(Modifier.width(8.dp))
                Text("退出登录")
            }
            Text(
                "PiConsole 移动端 · v1.0.0",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
    if (showPassword) {
        PasswordDialog(
            onDismiss = { showPassword = false },
            onSubmit = { current, next ->
                vm.changePassword(current, next)
                showPassword = false
            },
        )
    }
}

@Composable
private fun InfoRow(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, value: String) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(MaterialTheme.colorScheme.surface)
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.width(12.dp))
        Column {
            Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(2.dp))
            Text(value, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun PasswordDialog(onDismiss: () -> Unit, onSubmit: (String, String) -> Unit) {
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("修改密码") },
        text = {
            Column {
                OutlinedTextField(
                    value = current,
                    onValueChange = { current = it },
                    label = { Text("当前密码") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                )
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(
                    value = next,
                    onValueChange = { next = it },
                    label = { Text("新密码") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                )
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(
                    value = confirm,
                    onValueChange = { confirm = it },
                    label = { Text("确认新密码") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                )
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onSubmit(current, next) },
                enabled = next.isNotEmpty() && next == confirm,
            ) { Text("保存") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
}