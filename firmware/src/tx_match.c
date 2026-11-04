#include "tx_match.h"

#include <string.h>
#include "lifefi_config.h"

bool lifefi_is_tx_mac(const uint8_t mac[6])
{
    static const uint8_t prefix[] = LIFEFI_TX_MAC_PREFIX;
    return memcmp(mac, prefix, sizeof(prefix)) == 0;
}
