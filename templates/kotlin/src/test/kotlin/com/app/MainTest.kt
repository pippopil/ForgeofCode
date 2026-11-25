package com.app

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class MainTest {
    @Test
    fun `greet returns russian greeting`() {
        assertEquals("Привет, Кузница!", greet("Кузница"))
    }
}
