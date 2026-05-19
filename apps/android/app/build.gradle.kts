import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}

val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("keystore.properties")
if (keystorePropertiesFile.exists()) {
    keystorePropertiesFile.inputStream().use(keystoreProperties::load)
}
val sentryDsn = System.getenv("FIELDWORK_SENTRY_DSN").orEmpty()
fun escapedBuildConfigString(value: String): String = value.replace("\\", "\\\\").replace("\"", "\\\"")

val escapedSentryDsn = escapedBuildConfigString(sentryDsn)
val debugBiometricBypass = System.getenv("FIELDWORK_ANDROID_BIOMETRIC_BYPASS") == "true"
val debugPairingPayload = escapedBuildConfigString(System.getenv("FIELDWORK_ANDROID_PAIRING_PAYLOAD").orEmpty())

android {
    namespace = "app.fieldwork.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.fieldwork.android"
        minSdk = 30
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
        buildConfigField("String", "FIELDWORK_SENTRY_DSN", "\"$escapedSentryDsn\"")
        buildConfigField("boolean", "FIELDWORK_BIOMETRIC_BYPASS", "false")
        buildConfigField("String", "FIELDWORK_DEBUG_PAIRING_PAYLOAD", "\"\"")
    }

    sourceSets {
        getByName("main") {
            kotlin.srcDir("../generated")
        }
    }

    buildFeatures {
        buildConfig = true
        compose = true
    }

    testOptions {
        unitTests {
            isIncludeAndroidResources = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    signingConfigs {
        create("release") {
            if (keystorePropertiesFile.exists()) {
                storeFile = rootProject.file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
            }
        }
    }

    buildTypes {
        getByName("debug") {
            buildConfigField("boolean", "FIELDWORK_BIOMETRIC_BYPASS", debugBiometricBypass.toString())
            buildConfigField("String", "FIELDWORK_DEBUG_PAIRING_PAYLOAD", "\"$debugPairingPayload\"")
        }
        getByName("release") {
            buildConfigField("boolean", "FIELDWORK_BIOMETRIC_BYPASS", "false")
            buildConfigField("String", "FIELDWORK_DEBUG_PAIRING_PAYLOAD", "\"\"")
            if (keystorePropertiesFile.exists()) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(JvmTarget.JVM_17)
        }
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2026.03.01"))
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.10.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.10.0")
    implementation("androidx.navigation:navigation-compose:2.9.7")
    implementation("androidx.fragment:fragment-ktx:1.8.9")
    implementation("androidx.biometric:biometric-ktx:1.4.0-alpha02")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("io.sentry:sentry-android:8.41.0")
    implementation(platform("com.google.firebase:firebase-bom:34.13.0"))
    implementation("com.google.firebase:firebase-messaging")

    implementation("androidx.camera:camera-camera2:1.5.1")
    implementation("androidx.camera:camera-lifecycle:1.5.1")
    implementation("androidx.camera:camera-view:1.5.1")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")

    implementation("org.connectbot:termlib:0.0.35")
    implementation("net.java.dev.jna:jna:5.15.0@aar")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")

    debugImplementation("androidx.compose.ui:ui-tooling")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.16")
}
