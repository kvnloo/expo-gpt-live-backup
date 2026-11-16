package expo.modules.agentcontrol

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * Android silences a backgrounded app's microphone unless it runs a
 * microphone foreground service started while the app was visible. This keeps
 * the call alive while the assistant operates other apps.
 */
class CallService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val manager = getSystemService(NotificationManager::class.java)
    val channel = "agent_call"
    if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(
        NotificationChannel(channel, getString(R.string.agent_call_channel), NotificationManager.IMPORTANCE_LOW),
      )
    }
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val open = launch?.let {
      android.app.PendingIntent.getActivity(this, 0, it, android.app.PendingIntent.FLAG_IMMUTABLE)
    }
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, channel) else Notification.Builder(this)
    val notification = builder
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentTitle(getString(R.string.agent_call_text))
      .setOngoing(true)
      .setContentIntent(open)
      .build()
    if (Build.VERSION.SDK_INT >= 30) {
      startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
    } else {
      startForeground(1, notification)
    }
    return START_NOT_STICKY
  }
}
