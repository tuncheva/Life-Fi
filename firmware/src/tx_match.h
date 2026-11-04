/* Recognises the Life-Fi fixed transmitter by its MAC (tx_main.c sets it to
 * LIFEFI_TX_MAC_PREFIX + id). Pure logic, host-tested. */
#pragma once

#include <stdbool.h>
#include <stdint.h>

/* True if mac starts with LIFEFI_TX_MAC_PREFIX (any transmitter id). */
bool lifefi_is_tx_mac(const uint8_t mac[6]);
