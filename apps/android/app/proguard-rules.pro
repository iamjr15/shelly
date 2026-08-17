-keep class com.sun.jna.** { *; }
-keep class * implements com.sun.jna.Library { *; }
-keep class * implements com.sun.jna.Callback { *; }
-keep class uniffi.shelly_mobile_core.** { *; }
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

-dontwarn java.awt.**
