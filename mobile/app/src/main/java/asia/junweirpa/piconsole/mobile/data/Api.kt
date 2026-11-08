package asia.junweirpa.piconsole.mobile.data

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

data class Account(val id: String, val username: String, val displayName: String, val role: String)

data class SessionSummary(
    val id: String,
    val title: String,
    val updatedAt: String,
    val mode: String,
    val attention: Int,
)

data class ChatMessage(
    val key: String,
    val role: String,
    val authorName: String,
    val content: String,
    val timestamp: String,
)

data class SkillOption(val id: String, val name: String, val description: String)

data class UploadedAttachment(
    val id: String,
    val name: String,
    val size: Long,
    val kind: String,
    val mimeType: String,
    val downloadUrl: String,
)

class ApiException(val status: Int, message: String) : IOException(message)

class ApiClient(context: Context) {

    private val prefs = context.getSharedPreferences("piconsole", Context.MODE_PRIVATE)

    var baseUrl: String
        get() = prefs.getString(KEY_BASE, DEFAULT_BASE) ?: DEFAULT_BASE
        set(value) = prefs.edit().putString(KEY_BASE, value.trim().trimEnd('/')).apply()

    private val jar = object : CookieJar {
        private val store = mutableListOf<Cookie>()
        fun restore() {
            store.clear()
            val raw = prefs.getString(KEY_COOKIES, null) ?: return
            raw.split("\n").forEach { line ->
                val parts = line.split("\t")
                if (parts.size < 4) return@forEach
                runCatching {
                    store.add(Cookie.Builder().name(parts[0]).value(parts[1]).domain(parts[2]).path(parts[3]).build())
                }
            }
        }
        override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
            store.removeAll { existing -> cookies.any { it.name == existing.name && it.domain == existing.domain && it.path == existing.path } }
            store.addAll(cookies)
            prefs.edit().putString(KEY_COOKIES, store.joinToString("\n") { "${it.name}\t${it.value}\t${it.domain}\t${it.path}" }).apply()
        }
        override fun loadForRequest(url: HttpUrl): List<Cookie> = store.filter { it.matches(url) }
    }

    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .cookieJar(jar)
        .build()

    init { jar.restore() }

    fun validateServer(raw: String): String? {
        val cleaned = raw.trim().trimEnd('/')
        if (cleaned.isEmpty()) return "请填写服务器地址"
        val parsed = cleaned.toHttpUrlOrNull() ?: return "服务器地址格式不正确"
        if (parsed.scheme == "https") return null
        val local = parsed.host == "localhost" || parsed.host == "127.0.0.1" || parsed.host == "::1"
        if (parsed.scheme == "http" && local) return null
        return "仅允许 https 地址；http 仅限 localhost 本机调试"
    }

    private fun url(path: String): String = baseUrl.trimEnd('/') + path

    private fun encode(value: String): String = URLEncoder.encode(value, "UTF-8")

    private fun request(method: String, path: String, body: JSONObject? = null): Request {
        val builder = Request.Builder().url(url(path)).header("Accept", "application/json")
        val payload = (body?.toString() ?: "{}").toRequestBody("application/json; charset=utf-8".toMediaType())
        when (method) {
            "GET" -> builder.get()
            "POST" -> builder.post(payload)
            "PATCH" -> builder.patch(payload)
            "DELETE" -> builder.delete()
        }
        return builder.build()
    }

    private suspend fun call(req: Request): JSONObject = withContext(Dispatchers.IO) {
        client.newCall(req).execute().use { response ->
            val text = response.body?.string().orEmpty()
            val data = if (text.isBlank()) JSONObject() else runCatching { JSONObject(text) }.getOrElse { JSONObject() }
            if (!response.isSuccessful) {
                throw ApiException(response.code, data.optString("error").ifBlank { "请求失败（${response.code}）" })
            }
            data
        }
    }

    suspend fun status(): Account? {
        val data = call(request("GET", "/api/auth/status"))
        if (!data.optBoolean("authenticated", false)) return null
        val user = data.optJSONObject("user") ?: return null
        return Account(
            id = user.optString("id"),
            username = user.optString("username"),
            displayName = user.optString("displayName"),
            role = user.optString("role"),
        )
    }

    suspend fun login(username: String, password: String): Account {
        val body = JSONObject().apply {
            put("username", username)
            put("password", password)
        }
        val data = call(request("POST", "/api/auth/login", body))
        val user = data.optJSONObject("user")
        return Account(
            id = user?.optString("id").orEmpty(),
            username = user?.optString("username").orEmpty().ifBlank { username },
            displayName = user?.optString("displayName").orEmpty().ifBlank { username },
            role = user?.optString("role").orEmpty(),
        )
    }

    suspend fun logout() { runCatching { call(request("POST", "/api/auth/logout", JSONObject())) } }

    suspend fun changePassword(current: String, next: String) {
        val body = JSONObject().apply {
            put("currentPassword", current)
            put("newPassword", next)
        }
        call(request("POST", "/api/auth/password", body))
    }

    suspend fun sessions(): List<SessionSummary> {
        val data = call(request("GET", "/api/sessions?limit=100"))
        val array = data.optJSONArray("sessions") ?: return emptyList()
        val result = mutableListOf<SessionSummary>()
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            val id = item.optString("id")
            if (id.isBlank()) continue
            val attention = when (val raw = item.opt("attention")) {
                is Number -> raw.toInt()
                is JSONObject -> raw.optInt("count", 0)
                else -> 0
            }
            result.add(
                SessionSummary(
                    id = id,
                    title = item.optString("title").ifBlank { "未命名会话" },
                    updatedAt = item.optString("updatedAt"),
                    mode = item.optString("mode"),
                    attention = attention,
                )
            )
        }
        return result
    }

    suspend fun history(sessionId: String): List<ChatMessage> {
        val data = call(request("GET", "/api/sessions/${encodePath(sessionId)}"))
        return parseMessages(data)
    }

    suspend fun skills(sessionId: String): List<SkillOption> {
        val data = call(request("GET", "/api/sessions/${encodePath(sessionId)}/skills"))
        val array = data.optJSONArray("skills") ?: return emptyList()
        val result = mutableListOf<SkillOption>()
        for (i in 0 until array.length()) {
            val item = array.optJSONObject(i) ?: continue
            result.add(SkillOption(item.optString("id"), item.optString("name"), item.optString("description")))
        }
        return result
    }

    suspend fun abort(sessionId: String) {
        runCatching { call(request("POST", "/api/sessions/${encodePath(sessionId)}/abort", JSONObject())) }
    }

    suspend fun uploadAttachment(sessionId: String, name: String, mimeType: String, bytes: ByteArray): UploadedAttachment {
        val req = Request.Builder()
            .url(url("/api/sessions/${encodePath(sessionId)}/attachments?name=${encode(name)}"))
            .header("Accept", "application/json")
            .post(bytes.toRequestBody(mimeType.toMediaType()))
            .build()
        val data = call(req)
        val item = data.optJSONObject("attachment") ?: throw ApiException(0, "服务未返回有效的附件")
        return UploadedAttachment(
            id = item.optString("id"),
            name = item.optString("name"),
            size = item.optLong("size"),
            kind = item.optString("kind"),
            mimeType = item.optString("mimeType"),
            downloadUrl = item.optString("downloadUrl"),
        )
    }

    private fun encodePath(value: String): String = value.replace("/", "%2F")

    fun streamMessage(
        sessionId: String,
        message: String,
        skillId: String?,
        onEvent: (JSONObject) -> Unit,
        onFailure: (String) -> Unit,
    ): Call {
        val body = JSONObject().apply {
            put("message", message)
            if (!skillId.isNullOrBlank()) put("skillId", skillId)
        }
        val req = Request.Builder()
            .url(url("/api/sessions/${encodePath(sessionId)}/messages"))
            .header("Accept", "text/event-stream")
            .post(body.toString().toRequestBody("application/json; charset=utf-8".toMediaType()))
            .build()
        val call = client.newCall(req)
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                onFailure(e.message ?: "连接中断，请检查网络后重试。")
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (!it.isSuccessful) {
                        onFailure("请求失败（${it.code}）")
                        return
                    }
                    val source = it.body?.source()
                    if (source == null) { onFailure("没有收到回复内容。"); return }
                    var buffer = StringBuilder()
                    while (!source.exhausted()) {
                        val line = source.readUtf8Line() ?: break
                        if (line.isBlank()) {
                            val block = buffer.toString()
                            buffer = StringBuilder()
                            val payload = block.lines()
                                .filter { it.startsWith("data:") }
                                .joinToString("\n") { it.removePrefix("data:").trimStart() }
                            if (payload.isNotBlank() && payload != "[DONE]") {
                                runCatching { JSONObject(payload) }.onSuccess { onEvent(it) }
                            }
                        } else {
                            buffer.append(line).append('\n')
                        }
                    }
                }
            }
        })
        return call
    }

    companion object {
        const val DEFAULT_BASE = "https://ai.junweirpa.asia"
        const val MAX_FILES = 10
        const val MAX_FILE_BYTES = 50L * 1024 * 1024
        private const val KEY_BASE = "base_url"
        private const val KEY_COOKIES = "cookies"
        fun parseMessages(data: JSONObject): List<ChatMessage> {
            val array = data.optJSONArray("messages")
                ?: data.optJSONArray("entries")
                ?: data.optJSONArray("history")
                ?: return emptyList()
            val result = mutableListOf<ChatMessage>()
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                val role = item.optString("role").ifBlank { item.optString("type").ifBlank { "assistant" } }
                val author = item.optString("authorName")
                    .ifBlank { item.optString("author_name") }
                    .ifBlank { item.optString("author") }
                    .ifBlank { if (role == "user") "我" else "智能体" }
                val content = flatten(item.opt("content"))
                if (content.isBlank()) continue
                result.add(
                    ChatMessage(
                        key = item.optString("id").ifBlank { "$i" },
                        role = role,
                        authorName = author,
                        content = content,
                        timestamp = item.optString("timestamp").ifBlank { item.optString("createdAt") },
                    )
                )
            }
            return result
        }

        fun flatten(value: Any?): String = when (value) {
            null -> ""
            is String -> value
            is JSONArray -> {
                val out = StringBuilder()
                for (i in 0 until value.length()) {
                    when (val block = value.opt(i)) {
                        is String -> out.append(block)
                        is JSONObject -> {
                            val text = block.optString("text")
                            if (text.isNotBlank()) out.append(text)
                        }
                    }
                }
                out.toString()
            }
            is JSONObject -> value.optString("text").ifBlank { value.optString("content") }
            else -> value.toString()
        }
    }
}