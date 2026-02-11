plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("io.gitlab.arturbosch.detekt")
}

android {
    namespace = "com.cadence.player"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.cadence.player"
        minSdk = 30  // Android 11
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"

        vectorDrawables {
            useSupportLibrary = true
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }

    composeOptions {
        kotlinCompilerExtensionVersion = "1.5.5"
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

detekt {
    buildUponDefaultConfig = true
    allRules = false
    parallel = true
    config.setFrom("$rootDir/config/detekt/detekt.yml")
    ignoreFailures = true
}

tasks.withType<io.gitlab.arturbosch.detekt.Detekt>().configureEach {
    jvmTarget = "17"
    reports {
        html.required.set(true)
        xml.required.set(true)
        sarif.required.set(true)
        txt.required.set(false)
    }
}

tasks.named("check").configure {
    dependsOn("detekt")
}

dependencies {
    // Core Android
    implementation("androidx.activity:activity:1.8.1")
    implementation("androidx.activity:activity-compose:1.8.1")
    implementation("androidx.core:core:1.12.0")
    implementation("androidx.lifecycle:lifecycle-common:2.6.2")
    implementation("androidx.lifecycle:lifecycle-viewmodel:2.6.2")

    // Compose
    implementation(platform("androidx.compose:compose-bom:2023.10.01"))
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.foundation:foundation-layout")
    implementation("androidx.compose.runtime:runtime")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-geometry")
    implementation("androidx.compose.ui:ui-graphics")
    implementation("androidx.compose.ui:ui-text")
    implementation("androidx.compose.ui:ui-unit")
    implementation("androidx.compose.material3:material3")

    // Media playback (no GMS needed)
    implementation("androidx.media3:media3-common:1.2.0")
    implementation("androidx.media3:media3-exoplayer:1.2.0")

    // Kotlin runtime
    implementation("org.jetbrains.kotlin:kotlin-stdlib:1.9.20")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.6.4")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-core:1.6.0")

    // JSON parsing
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.0")

    // Debug
    debugImplementation("androidx.compose.ui:ui-tooling")
    debugRuntimeOnly("androidx.compose.ui:ui-test-manifest")
}
