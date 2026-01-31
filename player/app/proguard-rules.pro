# Cadence Player ProGuard rules

# Keep serialization classes
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt

-keepclassmembers class kotlinx.serialization.json.** {
    *** Companion;
}
-keepclasseswithmembers class kotlinx.serialization.json.** {
    kotlinx.serialization.KSerializer serializer(...);
}

-keep,includedescriptorclasses class com.cadence.player.**$$serializer { *; }
-keepclassmembers class com.cadence.player.** {
    *** Companion;
}
-keepclasseswithmembers class com.cadence.player.** {
    kotlinx.serialization.KSerializer serializer(...);
}
