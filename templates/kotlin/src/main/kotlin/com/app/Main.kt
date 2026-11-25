package com.app

fun greet(name: String): String {
    return "Привет, $name!"
}

fun main() {
    println(greet("Мир"))
}
