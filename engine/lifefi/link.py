"""Which transmitter the board is locked to, from the frames' source MAC.

The Life-Fi transmitter (firmware esp32*_tx) sends with a locally administered MAC
1A:4C:46:54:58:xx (firmware/src/lifefi_config.h LIFEFI_TX_MAC_PREFIX, matched on
5 bytes by tx_match.c). It sits still, so position quality can trust it; a phone
hotspot moves and cannot be trusted. csi_recorder.parse_frame() gives src_mac as
lowercase "1a:4c:46:54:58:01".
"""

TX_PREFIX = "1a:4c:46:54:58"   # firmware/src/lifefi_config.h LIFEFI_TX_MAC_PREFIX


def is_fixed_tx(src_mac):
    """True when src_mac (str or None) is a Life-Fi transmitter's MAC."""
    return isinstance(src_mac, str) and src_mac.lower().startswith(TX_PREFIX + ":")


def transmitter_fixed(setting, src_mac):
    """rules.yaml position.transmitter_fixed: True or False force it (YAML true/false/yes/no
    load as bools; e.g. a router bolted to the wall has no Life-Fi MAC but is fixed).
    Anything else ("auto", missing, a quoted "true", 1, junk) means auto: decided from
    the source MAC of the frames. Compared with `is`, so ints and strings fall to auto."""
    if setting is True:
        return True
    if setting is False:
        return False
    return is_fixed_tx(src_mac)
