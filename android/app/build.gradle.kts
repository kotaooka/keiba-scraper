plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 版番号は GitHub Actions のビルド番号から作る（手元のビルドは 0）。
// versionCode が大きいほど新しい。アプリの更新確認はこの値をリリースの version.json と比べる
val runNumber = (System.getenv("GITHUB_RUN_NUMBER") ?: "0").toInt()
val commitSha = (System.getenv("GITHUB_SHA") ?: "local").take(7)
val builtAt = java.time.ZonedDateTime.now(java.time.ZoneId.of("Asia/Tokyo"))
    .format(java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm"))

android {
    namespace = "io.github.kotaooka.keiba"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.kotaooka.keiba"
        minSdk = 29
        // 35 にすると全画面表示（edge-to-edge）が強制されるため、当面 34 に据え置く
        targetSdk = 34
        // 大きな変更のときだけ "0.4" の部分を上げる。末尾はビルド番号
        versionCode = 1000 + runNumber
        versionName = "0.4.$runNumber"
        buildConfigField("String", "COMMIT", "\"$commitSha\"")
        buildConfigField("String", "BUILT_AT", "\"$builtAt\"")
    }

    buildFeatures {
        buildConfig = true
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
