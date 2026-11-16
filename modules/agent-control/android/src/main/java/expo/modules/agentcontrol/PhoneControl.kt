package expo.modules.agentcontrol

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Path
import android.graphics.Rect
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject

/**
 * Runs one catalog action on whatever is on screen. Every result says whether
 * it `landed` (the screen or volume visibly changed afterwards), so callers
 * never report a tap that Android accepted but nothing happened.
 */
class PhoneControl(private val service: AccessibilityService) {
  private data class Control(
    val node: AccessibilityNodeInfo,
    val label: String,
    val clickable: Boolean,
    val editable: Boolean,
    val scrollable: Boolean,
    val password: Boolean,
  )

  private companion object {
    const val MAX_VISIT = 600
    const val MAX_CONTROLS = 80
    const val SETTLE_MS = 450L
    val UNSAFE = Regex(
      "\\b(send|pay|buy|purchase|order|checkout|confirm|delete|remove|uninstall|install|transfer|call|dial|subscribe|sign ?out|log ?out|reset|erase|post|publish|accept|allow|share)\\b",
      RegexOption.IGNORE_CASE,
    )
  }

  fun screen(): JSONObject {
    val root = service.rootInActiveWindow ?: return fail("no_window")
    val controls = JSONArray()
    for (c in controls(root)) {
      controls.put(
        JSONObject()
          .put("label", c.label)
          .put("clickable", c.clickable)
          .put("editable", c.editable)
          .put("scrollable", c.scrollable),
      )
    }
    return JSONObject().put("ok", true).put("package", root.packageName?.toString()).put("controls", controls)
  }

  fun act(request: JSONObject): JSONObject = try {
    when (request.optString("kind")) {
      "global" -> global(request.optString("action"))
      "scroll" -> scroll(request.optString("direction"))
      "open_app" -> openApp(request.optString("app"))
      "tap" -> tap(request.optString("target"), request.optBoolean("confirmed"))
      "type" -> type(request.optString("text"), request.optString("target").ifBlank { null })
      "media" -> media(request.optString("action"))
      "volume" -> volume(request.optString("action"))
      else -> fail("invalid_action")
    }
  } catch (e: Exception) {
    fail("phone_control_failed").put("detail", e.javaClass.simpleName)
  }

  private fun global(action: String): JSONObject {
    val id = when (action) {
      "back" -> AccessibilityService.GLOBAL_ACTION_BACK
      "home" -> AccessibilityService.GLOBAL_ACTION_HOME
      "recents" -> AccessibilityService.GLOBAL_ACTION_RECENTS
      "notifications" -> AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS
      "quick_settings" -> AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS
      "lock" -> if (Build.VERSION.SDK_INT >= 28) AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN else return fail("unsupported")
      "screenshot" -> if (Build.VERSION.SDK_INT >= 28) AccessibilityService.GLOBAL_ACTION_TAKE_SCREENSHOT else return fail("unsupported")
      else -> return fail("invalid_action")
    }
    return landed { service.performGlobalAction(id) }
  }

  private fun scroll(direction: String): JSONObject {
    val root = service.rootInActiveWindow ?: return fail("no_window")
    val forward = direction == "down" || direction == "right"
    val target = controls(root, all = true).filter { it.scrollable }.maxByOrNull { area(it.node) }
    if (target != null) {
      val action = if (forward) AccessibilityNodeInfo.ACTION_SCROLL_FORWARD else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
      val result = landed { target.node.performAction(action) }
      if (result.optBoolean("landed")) return result
    }
    // No scrollable node, or it did not move: swipe across the middle of the screen.
    val metrics = service.resources.displayMetrics
    val w = metrics.widthPixels.toFloat()
    val h = metrics.heightPixels.toFloat()
    val (x1, y1, x2, y2) = when (direction) {
      "down" -> listOf(w / 2, h * 0.7f, w / 2, h * 0.3f)
      "up" -> listOf(w / 2, h * 0.3f, w / 2, h * 0.7f)
      "right" -> listOf(w * 0.8f, h / 2, w * 0.2f, h / 2)
      "left" -> listOf(w * 0.2f, h / 2, w * 0.8f, h / 2)
      else -> return fail("invalid_action")
    }
    return landed { gesture(x1, y1, x2, y2, 300) }
  }

  private fun openApp(name: String): JSONObject {
    val pm = service.packageManager
    val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
    val apps = pm.queryIntentActivities(launcher, 0).map { it.activityInfo.packageName to it.loadLabel(pm).toString() }
      .distinctBy { it.first }
    val want = norm(name)
    val exact = apps.filter { norm(it.second) == want }
    val matches = exact.ifEmpty { apps.filter { norm(it.second).startsWith(want) } }
      .ifEmpty { apps.filter { norm(it.second).contains(want) } }
    if (matches.isEmpty()) return fail("app_not_found")
    if (matches.size > 1) return fail("ambiguous").put("candidates", JSONArray(matches.take(5).map { it.second }))
    val intent = pm.getLaunchIntentForPackage(matches[0].first) ?: return fail("app_not_found")
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return landed { service.startActivity(intent); true }.put("app", matches[0].second)
  }

  private fun tap(target: String, confirmed: Boolean): JSONObject {
    val root = service.rootInActiveWindow ?: return fail("no_window")
    if (!confirmed && UNSAFE.containsMatchIn(target)) return fail("confirmation_required")
    val match = find(controls(root, all = true), target) ?: return fail("not_found")
    if (match.isFailure) return match.exceptionOrNull()!!.let { (it as Ambiguous).result }
    val control = match.getOrThrow()
    if (!confirmed && UNSAFE.containsMatchIn(control.label)) return fail("confirmation_required")
    var node: AccessibilityNodeInfo? = control.node
    while (node != null && !node.isClickable) node = node.parent
    return landed {
      if (node != null) {
        node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
      } else {
        val r = Rect().also { control.node.getBoundsInScreen(it) }
        gesture(r.exactCenterX(), r.exactCenterY(), r.exactCenterX(), r.exactCenterY(), 60)
      }
    }.put("tapped", control.label)
  }

  private fun type(text: String, target: String?): JSONObject {
    val root = service.rootInActiveWindow ?: return fail("no_window")
    val editable = controls(root, all = true).filter { it.editable }
    val field = when {
      target != null -> find(editable, target)?.getOrNull()
      else -> root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.let { focused ->
        editable.firstOrNull { it.node == focused }
      } ?: editable.singleOrNull()
    } ?: return fail(if (editable.size > 1) "ambiguous" else "not_found")
    if (field.password) return fail("password_field")
    val args = Bundle().apply {
      putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
    }
    return landed { field.node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args) }
  }

  private fun media(action: String): JSONObject {
    val code = when (action) {
      "play" -> KeyEvent.KEYCODE_MEDIA_PLAY
      "pause" -> KeyEvent.KEYCODE_MEDIA_PAUSE
      "next" -> KeyEvent.KEYCODE_MEDIA_NEXT
      "previous" -> KeyEvent.KEYCODE_MEDIA_PREVIOUS
      else -> return fail("invalid_action")
    }
    val audio = service.getSystemService(AudioManager::class.java)
    audio.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, code))
    audio.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, code))
    // Media apps give no readback here; say so instead of guessing.
    return JSONObject().put("ok", true).put("landed", JSONObject.NULL)
  }

  private fun volume(action: String): JSONObject {
    val audio = service.getSystemService(AudioManager::class.java)
    val stream = AudioManager.STREAM_MUSIC
    val before = audio.getStreamVolume(stream) to audio.isStreamMute(stream)
    val direction = when (action) {
      "up" -> AudioManager.ADJUST_RAISE
      "down" -> AudioManager.ADJUST_LOWER
      "mute" -> AudioManager.ADJUST_TOGGLE_MUTE
      else -> return fail("invalid_action")
    }
    audio.adjustStreamVolume(stream, direction, AudioManager.FLAG_SHOW_UI)
    val after = audio.getStreamVolume(stream) to audio.isStreamMute(stream)
    return JSONObject().put("ok", true).put("landed", before != after)
      .put("volume", after.first).put("max", audio.getStreamMaxVolume(stream)).put("muted", after.second)
  }

  // -- helpers ---------------------------------------------------------------

  private class Ambiguous(val result: JSONObject) : Exception()

  /** Exact label first, then a unique containing label; never picks among several. */
  private fun find(controls: List<Control>, target: String): Result<Control>? {
    val want = norm(target)
    val exact = controls.filter { norm(it.label) == want }
    val pool = exact.ifEmpty { controls.filter { norm(it.label).contains(want) } }
    val distinct = pool.distinctBy { Rect().also { r -> it.node.getBoundsInScreen(r) } }
    return when {
      distinct.isEmpty() -> null
      distinct.size == 1 -> Result.success(distinct[0])
      else -> Result.failure(
        Ambiguous(fail("ambiguous").put("candidates", JSONArray(distinct.take(6).map { it.label }))),
      )
    }
  }

  private fun controls(root: AccessibilityNodeInfo, all: Boolean = false): List<Control> {
    val out = ArrayList<Control>()
    val queue = ArrayDeque<AccessibilityNodeInfo>().apply { add(root) }
    var visited = 0
    while (queue.isNotEmpty() && visited < MAX_VISIT && (all || out.size < MAX_CONTROLS)) {
      val node = queue.removeFirst()
      visited++
      if (!node.isVisibleToUser) continue
      for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
      val password = node.isPassword
      // Never read typed values or passwords: editable fields use their hint or description.
      val label = when {
        node.isEditable || password ->
          (if (Build.VERSION.SDK_INT >= 26) node.hintText else null)?.toString()
            ?: node.contentDescription?.toString() ?: if (password) "password field" else "text field"
        else -> node.text?.toString()?.takeIf { it.isNotBlank() } ?: node.contentDescription?.toString()
      }?.trim()?.take(100)
      val scrollable = node.isScrollable
      if (label.isNullOrBlank() && !scrollable) continue
      out.add(
        Control(node, label ?: "", node.isClickable || hasClickableParent(node), node.isEditable, scrollable, password),
      )
    }
    return out
  }

  private fun hasClickableParent(node: AccessibilityNodeInfo): Boolean {
    var p = node.parent
    var depth = 0
    while (p != null && depth++ < 4) {
      if (p.isClickable) return true
      p = p.parent
    }
    return false
  }

  /** The package plus visible labels: changes whenever the screen meaningfully does. */
  private fun fingerprint(): Int {
    val root = service.rootInActiveWindow ?: return 0
    return (root.packageName?.toString() + "|" + controls(root).joinToString("|") { it.label }).hashCode()
  }

  private fun landed(perform: () -> Boolean): JSONObject {
    val before = fingerprint()
    if (!perform()) return fail("not_accepted")
    SystemClock.sleep(SETTLE_MS)
    val after = fingerprint()
    return JSONObject().put("ok", true).put("landed", before != after)
      .put("package", service.rootInActiveWindow?.packageName?.toString())
  }

  private fun gesture(x1: Float, y1: Float, x2: Float, y2: Float, ms: Long): Boolean {
    val path = Path().apply {
      moveTo(x1, y1)
      lineTo(x2, y2)
    }
    return service.dispatchGesture(
      GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, ms)).build(),
      null,
      null,
    )
  }

  private fun area(node: AccessibilityNodeInfo): Int =
    Rect().also { node.getBoundsInScreen(it) }.let { it.width() * it.height() }

  private fun norm(s: String) = s.lowercase().replace(Regex("[^a-z0-9 ]"), " ").replace(Regex("\\s+"), " ").trim()

  private fun fail(code: String) = JSONObject().put("ok", false).put("error", code)
}
