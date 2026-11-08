package asia.junweirpa.piconsole.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ErrorOutline
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import asia.junweirpa.piconsole.mobile.MainViewModel
import asia.junweirpa.piconsole.mobile.data.ChatMessage
import asia.junweirpa.piconsole.mobile.data.SessionSummary

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(vm: MainViewModel, session: SessionSummary) {
    val context = LocalContext.current
    val listState = rememberLazyListState()
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) vm.attachPickedFile(context, uri)
    }
    BackHandler { vm.closeSession() }
    LaunchedEffect(vm.messages.size, vm.liveText.length) {
        val count = listState.layoutInfo.totalItemsCount
        if (count > 0) listState.animateScrollToItem(count - 1)
    }
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = { vm.closeSession() }) { Icon(Icons.Default.ArrowBack, "返回") }
                },
                title = {
                    Column {
                        Text(
                            session.title,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            fontWeight = FontWeight.SemiBold,
                        )
                        Text(
                            when {
                                vm.streaming -> "正在处理…"
                                session.mode == "workspace" -> "可执行任务"
                                else -> "只读模式"
                            },
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
            )
        },
        bottomBar = {
            Column(Modifier.background(MaterialTheme.colorScheme.surface)) {
                vm.pendingFile?.let { PendingFileRow(vm, it) }
                if (vm.skills.isNotEmpty()) SkillRow(vm)
                InputRow(vm) {
                    picker.launch(arrayOf("image/*", "application/pdf", "text/plain", "text/csv"))
                }
            }
        },
    ) { inner ->
        Column(Modifier.padding(inner).fillMaxSize()) {
            vm.chatError?.let { Banner(Icons.Default.ErrorOutline, it, MaterialTheme.colorScheme.error) }
            LazyColumn(
                state = listState,
                modifier = Modifier.weight(1f).fillMaxWidth().padding(horizontal = 12.dp),
                contentPadding = PaddingValues(vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(vm.messages, key = { it.key }) { message ->
                    MessageBubble(message, vm.account?.displayName.orEmpty())
                }
                if (vm.liveText.isNotBlank()) {
                    item(key = "live") {
                        MessageBubble(ChatMessage("live", "assistant", "智能体", vm.liveText, ""), vm.account?.displayName.orEmpty())
                    }
                }
                vm.toolStatus?.let { status ->
                    item(key = "tool") { ToolRow(status) }
                }
            }
        }
    }
}

@Composable
private fun MessageBubble(message: ChatMessage, myName: String) {
    val mine = message.role == "user" && message.authorName == myName
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
        Column(
            Modifier
                .widthIn(max = 300.dp)
                .clip(RoundedCornerShape(16.dp))
                .background(if (mine) BrandBlue else MaterialTheme.colorScheme.surface)
                .padding(horizontal = 14.dp, vertical = 10.dp),
        ) {
            if (!mine && message.authorName.isNotBlank()) {
                Text(
                    message.authorName,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(4.dp))
            }
            Text(
                message.content,
                color = if (mine) Color.White else MaterialTheme.colorScheme.onSurface,
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun ToolRow(text: String) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
        Spacer(Modifier.width(10.dp))
        Text(text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun PendingFileRow(vm: MainViewModel, file: MainViewModel.PendingFile) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 4.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(start = 10.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Default.AttachFile, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.width(8.dp))
        Text(
            file.name,
            Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            style = MaterialTheme.typography.bodySmall,
        )
        IconButton(onClick = { vm.clearPendingFile() }) {
            Icon(Icons.Default.Close, "移除附件", Modifier.size(18.dp))
        }
    }
}

@Composable
private fun SkillRow(vm: MainViewModel) {
    Row(
        Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        vm.skills.forEach { skill ->
            FilterChip(
                selected = vm.selectedSkill == skill.id,
                onClick = { vm.toggleSkill(skill.id) },
                label = { Text(skill.name, maxLines = 1) },
            )
        }
    }
}

@Composable
private fun InputRow(vm: MainViewModel, onPick: () -> Unit) {
    Row(Modifier.padding(horizontal = 8.dp, vertical = 8.dp), verticalAlignment = Alignment.Bottom) {
        IconButton(onClick = onPick) { Icon(Icons.Default.AttachFile, "添加附件") }
        OutlinedTextField(
            value = vm.draft,
            onValueChange = { vm.draft = it },
            modifier = Modifier.weight(1f),
            placeholder = { Text("说点什么…") },
            maxLines = 5,
            shape = RoundedCornerShape(22.dp),
        )
        Spacer(Modifier.width(6.dp))
        if (vm.streaming) {
            FilledTonalButton(onClick = { vm.abort() }, shape = RoundedCornerShape(22.dp)) {
                Icon(Icons.Default.Stop, "停止", Modifier.size(18.dp))
                Spacer(Modifier.width(4.dp))
                Text("停止")
            }
        } else {
            FilledIconButton(
                onClick = { vm.send() },
                enabled = vm.draft.isNotBlank() || vm.pendingFile != null,
            ) {
                Icon(Icons.Default.Send, "发送")
            }
        }
    }
}