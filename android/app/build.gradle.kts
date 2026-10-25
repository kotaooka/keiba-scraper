plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.kotaooka.keiba"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.kotaooka.keiba"
        minSdk = 29
        // 35 にすると全画面表示（edge-to-edge）が強制されるため、当面 34 に据え置く
        targetSdk = 34
        versionCode = 2
        versionName = "0.2.0"
    }

    signingConfigs {
        // リポジトリに置いたデバッグ用の鍵で署名する。
        // ビルドごとに鍵が変わると上書きインストールできないため（秘密の鍵ではない）
        getByName("debug") {
            storeFile = file("../debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        getByName("debug") {
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
}
