package asia.junweirpa.piconsole.mobile

import android.app.Application
import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import asia.junweirpa.piconsole.mobile.data.Account
import asia.junweirpa.piconsole.mobile.data.ApiClient
import asia.junweirpa.piconsole.mobile.data.ChatMessage
import asia.junweirpa.piconsole.mobile.data.SessionSummary
import asia.junweirpa.piconsole.mobile.data.SkillOption
import kotlinx.coroutines.launch
import okhttp3.Call
import org.json.JSONObject
import java.io.IOException

class MainViewModel(app: Application) : AndroidViewModel(app) {

    enum class Phase { Loading, Login, Home }

    data class PendingFile(val name: String, val size: Long, val mimeType: String, val bytes: ByteArray)

    private val api = ApiClient(app)
    private val main = Handler(Looper.getMainLooper())
    private var streamCall: Call? = null

    var phase by mutableStateOf(Phase.Loading)
        private set
    var account by mutableStateOf<Account?>(null)
        private set
    var serverUrl by mutableStateOf(api.baseUrl)
    var username by mutableStateOf("")
    var password by mutableStateOf("")
    var loginError by mutableStateOf<String?>(null)
        private set
    var busy by mutableStateOf(false)
        private set
    var sessions by mutableStateOf<List<SessionSummary>>(emptyList())
        private set
    var listError by mutableStateOf<String?>(null)
        private set
    var tab by mutableStateOf(0)
    var openSession by mutableStateOf<SessionSummary?>(null)
        private set
    var messages by mutableStateOf<List<ChatMessage>>(emptyList())
        private set
    var liveText by mutableStateOf("")
        private set
    var draft by mutableStateOf("")
    var streaming by mutableStateOf(false)
        private set
    var toolStatus by mutableStateOf<String?>(null)
        private set
    var chatError by mutableStateOf<String?>(null)
        private set
    var skills by mutableStateOf<List<SkillOption>>(emptyList())
        private set
    var selectedSkill by mutableStateOf<String?>(null)
        private set
    var pendingFile by mutableStateOf<PendingFile?>(null)
        private set
    var notice by mutableStateOf<String?>(null)
        private set

    init { checkAuth() }

    fun checkAuth() {
        viewModelScope.launch {
            busy = true
            try {
                val current = api.status()
                account = current
                phase = if (current == null) Phase.Login else Phase.Home
                if (current != null) refreshSessions()
            } catch (error: Exception) {
                phase = Phase.Login
                notice = error.message
            } finally {
                busy = false
            }
        }
    }

    fun applyServer(): Boolean {
        val problem = api.validateServer(serverUrl)
        if (problem != null) { loginError = problem; return false }
        api.baseUrl = serverUrl
        return true
    }

    fun login() {
        val name = username.trim()
        val secret = password
        if (name.isEmpty() || secret.isEmpty()) { loginError = "请填写账号和密码"; return }
        if (!applyServer()) return
        viewModelScope.launch {
            busy = true
            loginError = null
            try {
                account = api.login(name, secret)
                password = ""
                phase = Phase.Home
                refreshSessions()
            } catch (error: Exception) {
                loginError = error.message ?: "登录失败，请重试。"
            } finally {
                busy = false
            }
        }
    }

    fun logout() {
        viewModelScope.launch {
            runCatching { api.logout() }
            account = null
            sessions = emptyList()
            openSession = null
            phase = Phase.Login
        }
    }

    fun refreshSessions() {
        viewModelScope.launch {
            listError = null
            try {
                sessions = api.sessions()
            } catch (error: Exception) {
                listError = error.message ?: "无法加载会话列表。"
            }
        }
    }

    fun openSession(session: SessionSummary) {
        openSession = session
        messages = emptyList()
        liveText = ""
        toolStatus = null
        chatError = null
        selectedSkill = null
        viewModelScope.launch {
            try {
                messages = api.history(session.id)
                skills = api.skills(session.id)
            } catch (error: Exception) {
                chatError = error.message ?: "无法加载对话记录。"
            }
        }
    }

    fun closeSession() {
        streamCall?.cancel()
        streamCall = null
        streaming = false
        toolStatus = null
        liveText = ""
        openSession = null
    }

    fun toggleSkill(id: String) {
        selectedSkill = if (selectedSkill == id) null else id
    }

    fun clearPendingFile() { pendingFile = null }

    fun attachPickedFile(context: Context, uri: Uri) {
        viewModelScope.launch {
            try {
                val resolver = context.contentResolver
                val bytes = resolver.openInputStream(uri)?.use { it.readBytes() } ?: throw IOException("无法读取所选文件。")
                if (bytes.isEmpty()) throw IOException("所选文件为空。")
                if (bytes.size > ApiClient.MAX_FILE_BYTES) throw IOException("单个文件不能超过 50 MiB。")
                pendingFile = PendingFile(
                    name = displayName(resolver, uri),
                    size = bytes.size.toLong(),
                    mimeType = resolver.getType(uri) ?: "application/octet-stream",
                    bytes = bytes,
                )
            } catch (error: Exception) {
                notice = error.message ?: "无法读取所选文件。"
            }
        }
    }

    private fun displayName(resolver: android.content.ContentResolver, uri: Uri): String {
        var name = "附件"
        runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (index >= 0) cursor.getString(index)?.let { name = it }
                }
            }
        }
        return name.take(200)
    }

    fun send() {
        val session = openSession ?: return
        val text = draft.trim()
        val file = pendingFile
        if (text.isEmpty() && file == null) return
        if (streaming) return
        viewModelScope.launch {
            busy = true
            try {
                val attachment = file?.let { api.uploadAttachment(session.id, it.name, it.mimeType, it.bytes) }
                val body = if (attachment != null) {
                    if (text.isEmpty()) "[附件] ${attachment.name}" else "$text\n\n[附件] ${attachment.name}"
                } else {
                    text
                }
                draft = ""
                pendingFile = null
                messages = messages + ChatMessage("local-${System.currentTimeMillis()}", "user", account?.displayName ?: "我", body, "")
                streaming = true
                liveText = ""
                toolStatus = null
                chatError = null
                streamCall = api.streamMessage(
                    sessionId = session.id,
                    message = body,
                    skillId = selectedSkill,
                    onEvent = { event -> handleEvent(event) },
                    onFailure = { message -> main.post { chatError = message; streaming = false; toolStatus = null } },
                )
            } catch (error: Exception) {
                chatError = error.message ?: "发送失败，请重试。"
                streaming = false
            } finally {
                busy = false
            }
        }
    }

    private fun handleEvent(event: JSONObject) {
        main.post {
            when (event.optString("type")) {
                "text_delta" -> liveText += event.optString("delta")
                "tool_start" -> toolStatus = "正在执行 ${event.optString("name")}"
                "tool_update" -> toolStatus = "正在执行 ${event.optString("name")}"
                "tool_end" -> toolStatus = null
                "user" -> {
                    val author = event.optString("authorName").ifBlank { "群成员" }
                    messages = messages + ChatMessage("srv-${System.currentTimeMillis()}", "user", author, event.optString("content"), event.optString("timestamp"))
                }
                "error" -> { chatError = event.optString("message"); streaming = false; toolStatus = null }
                "access_revoked" -> { chatError = event.optString("message"); streaming = false; toolStatus = null }
                "done" -> {
                    if (liveText.isNotBlank()) {
                        messages = messages + ChatMessage("asst-${System.currentTimeMillis()}", "assistant", "智能体", liveText, "")
                    }
                    liveText = ""
                    toolStatus = null
                    streaming = false
                }
            }
        }
    }

    fun abort() {
        val session = openSession ?: return
        streamCall?.cancel()
        streamCall = null
        viewModelScope.launch {
            runCatching { api.abort(session.id) }
            streaming = false
            toolStatus = null
        }
    }

    fun changePassword(current: String, next: String) {
        viewModelScope.launch {
            try {
                api.changePassword(current, next)
                notice = "密码已更新。"
            } catch (error: Exception) {
                notice = error.message ?: "密码修改失败。"
            }
        }
    }

    fun clearNotice() { notice = null }
}