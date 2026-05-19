package app.fieldwork.android.core

import android.content.Context

object FieldworkNative {
    init {
        System.loadLibrary("fieldwork_mobile_core")
    }

    external fun installAndroidContext(context: Context)
}
