/* tx_match.c: the receiver recognises the fixed transmitter by its MAC prefix. */
#include "host_test.h"
#include "tx_match.h"

int main(int argc, char **argv)
{
    host_init(argc, argv, 1);

    const uint8_t tx01[6] = { 0x1A, 0x4C, 0x46, 0x54, 0x58, 0x01 };
    const uint8_t tx07[6] = { 0x1A, 0x4C, 0x46, 0x54, 0x58, 0x07 };
    const uint8_t router[6] = { 0xf0, 0x33, 0xe5, 0x66, 0x52, 0xb0 };
    const uint8_t near[6] = { 0x1A, 0x4C, 0x46, 0x54, 0x59, 0x01 };   /* last prefix byte differs */
    const uint8_t first[6] = { 0x1B, 0x4C, 0x46, 0x54, 0x58, 0x01 };  /* first byte differs */

    CHECK(lifefi_is_tx_mac(tx01), "transmitter id 1 matches");
    CHECK(lifefi_is_tx_mac(tx07), "another transmitter id matches too");
    CHECK(!lifefi_is_tx_mac(router), "a router MAC does not match");
    CHECK(!lifefi_is_tx_mac(near), "prefix differing in its last byte does not match");
    CHECK(!lifefi_is_tx_mac(first), "prefix differing in its first byte does not match");

    return host_finish("test_tx_match");
}
