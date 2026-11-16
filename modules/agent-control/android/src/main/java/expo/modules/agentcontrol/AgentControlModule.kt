package expo.modules.agentcontrol

import android.content.Intent
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

class AgentControlModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext)

  override fun definition() = ModuleDefinition {
    Name("AgentControl")

    Function("isEnabled") { AgentControlService.instance != null }

    Function("openSettings") {
      context.startActivity(
        Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
    }

    AsyncFunction("screen") {
      val service = AgentControlService.instance ?: return@AsyncFunction disabled()
      PhoneControl(service).screen().toString()
    }

    AsyncFunction("act") { action: String ->
      val service = AgentControlService.instance ?: return@AsyncFunction disabled()
      val request = try {
        JSONObject(action)
      } catch (_: Exception) {
        return@AsyncFunction JSONObject().put("ok", false).put("error", "invalid_action").toString()
      }
      PhoneControl(service).act(request).toString()
    }

    Function("startCall") {
      val intent = Intent(context, CallService::class.java)
      if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
    }

    Function("stopCall") {
      context.stopService(Intent(context, CallService::class.java))
    }
  }

  private fun disabled() = JSONObject().put("ok", false).put("error", "permission_required").toString()
}
