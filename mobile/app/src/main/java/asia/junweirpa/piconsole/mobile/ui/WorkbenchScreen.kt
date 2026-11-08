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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import asia.junweirpa.piconsole.mobile.MainViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkbenchScreen(vm: MainViewModel, padding: PaddingValues) {
    val admin = vm.account?.role == "admin"
    Scaffold(
        modifier = Modifier.padding(padding),
        topBar = { TopAppBar(title = { Text("工作台", fontWeight = FontWeight.Bold) }) },
    ) { inner ->
        Column(Modifier.padding(inner).fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Card(
                colors = CardDefaults.cardColors(containerColor = BrandBlueSoft),
                shape = RoundedCornerShape(16.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier.size(38.dp).clip(RoundedCornerShape(12.dp)).background(BrandBlue),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(Icons.Default.AutoAwesome, null, tint = androidx.compose.ui.graphics.Color.White)
                    }
                    Spacer(Modifier.width(12.dp))
                    Column {
                        Text("当前身份：${if (admin) "管理员" else "员工"}", fontWeight = FontWeight.SemiBold, color = BrandBlue)
                        Spacer(Modifier.height(2.dp))
                        Text(
                            if (admin) "可管理技能、定时任务与邮箱连接" else "可查看与使用已授权的技能",
                            style = MaterialTheme.typography.labelSmall,
                            color = BrandBlue,
                        )
                    }
                }
            }
            Text("技能中心", fontWeight = FontWeight.SemiBold)
            if (vm.skills.isEmpty()) {
                Text(
                    "选择左侧会话后，这里会列出该群聊可用的技能。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(vm.skills, key = { it.id }) { skill ->
                        Card(
                            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                            shape = RoundedCornerShape(14.dp),
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Column(Modifier.padding(14.dp)) {
                                Text(skill.name, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                if (skill.description.isNotBlank()) {
                                    Spacer(Modifier.height(4.dp))
                                    Text(
                                        skill.description,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 3,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                            }
                        }
                    }
                }
            }
            Text("安全说明", fontWeight = FontWeight.SemiBold)
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(14.dp))
                    .background(MaterialTheme.colorScheme.surface)
                    .padding(14.dp),
                verticalAlignment = Alignment.Top,
            ) {
                Icon(Icons.Default.Lock, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(10.dp))
                Text(
                    "移动端只与公司工作台通信，不在手机本地执行任何脚本；任务执行与命令运行仍由服务端在受控环境中完成。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}