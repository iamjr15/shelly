package app.shelly.android.core

import android.content.Context

object ShellyNative {
    init {
        System.loadLibrary("shelly_mobile_core")
    }

    external fun installAndroidContext(context: Context)
}
