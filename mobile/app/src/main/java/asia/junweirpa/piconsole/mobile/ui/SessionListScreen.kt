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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import asia.junweirpa.piconsole.mobile.MainViewModel
import asia.junweirpa.piconsole.mobile.data.SessionSummary

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionListScreen(vm: MainViewModel, padding: PaddingValues) {
    Scaffold(
        modifier = Modifier.padding(padding),
        topBar = {
            TopAppBar(
                title = { Text("会话", fontWeight = FontWeight.Bold) },
                actions = {
                    IconButton(onClick = { vm.refreshSessions() }) {
                        Icon(Icons.Default.Refresh, "刷新")
                    }
                },
            )
        },
    ) { inner ->
        Column(Modifier.padding(inner).fillMaxSize()) {
            if (vm.listError != null) {
                Banner(Icons.Default.ErrorOutline, vm.listError!!, MaterialTheme.colorScheme.error)
            }
            if (vm.sessions.isEmpty() && vm.listError == null) {
                EmptyState(
                    title = "还没有会话",
                    body = "管理员创建业务群并把你加入后，这里会出现你的智能体工作空间。",
                )
            } else {
                LazyColumn(
                    contentPadding = PaddingValues(16.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(vm.sessions, key = { it.id }) { session ->
                        SessionCard(session) { vm.openSession(session) }
                    }
                }
            }
        }
    }
}

@Composable
private fun SessionCard(session: SessionSummary, onClick: () -> Unit) {
    Card(
        onClick = onClick,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(16.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(
                Modifier
                    .size(44.dp)
                    .clip(RoundedCornerShape(13.dp))
                    .background(BrandBlueSoft),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    session.title.take(1).ifBlank { "群" },
                    color = BrandBlue,
                    fontWeight = FontWeight.Bold,
                    fontSize = 18.sp,
                )
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    session.title,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    fontWeight = FontWeight.SemiBold,
                )
                Spacer(Modifier.height(2.dp))
                Text(
                    if (session.mode == "workspace") "可执行任务 · 协作空间" else "只读模式 · 协作空间",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (session.attention > 0) {
                Box(
                    Modifier
                        .size(20.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.error),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        if (session.attention > 99) "99+" else session.attention.toString(),
                        color = Color.White,
                        fontSize = 11.sp,
                    )
                }
            }
        }
    }
}

@Composable
fun Banner(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String, tint: Color) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 10.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(tint.copy(alpha = 0.08f))
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = tint)
        Spacer(Modifier.width(10.dp))
        Text(text, color = tint, style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
fun EmptyState(title: String, body: String) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(title, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.height(8.dp))
        Text(
            body,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}