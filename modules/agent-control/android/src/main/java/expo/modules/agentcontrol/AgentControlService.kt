package expo.modules.agentcontrol

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.view.accessibility.AccessibilityEvent

/** Bound by Android only after the user enables it in Accessibility settings. */
class AgentControlService : AccessibilityService() {
  companion object {
    @Volatile var instance: AgentControlService? = null
      private set
  }

  override fun onServiceConnected() {
    instance = this
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {}

  override fun onInterrupt() {}

  override fun onUnbind(intent: Intent?): Boolean {
    instance = null
    return super.onUnbind(intent)
  }

  override fun onDestroy() {
    instance = null
    super.onDestroy()
  }
}
