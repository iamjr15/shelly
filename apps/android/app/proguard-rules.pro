-keep class com.sun.jna.** { *; }
-keep class * implements com.sun.jna.Library { *; }
-keep class * implements com.sun.jna.Callback { *; }
-keep class uniffi.shelly_mobile_core.** { *; }

-dontwarn java.awt.**
