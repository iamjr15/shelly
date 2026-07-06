package app.shelly.android.features.sessions

internal fun killSessionBody(name: String, laptopName: String): String =
    "This stops \"$name\" on $laptopName and ends its running processes."
