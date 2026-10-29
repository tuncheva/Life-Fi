#include "csi_frame.h"

#include <string.h>

size_t csi_frame_build(uint8_t *out, size_t cap, const csi_packet_t *p, uint8_t node_id,
                       uint32_t boot_id, uint32_t seq)
{
    size_t len = sizeof(csi_frame_hdr_t) + p->len;
    if (len > cap) {
        return 0;
    }
    csi_frame_hdr_t h;
    memset(&h, 0, sizeof(h));
    h.magic = CSI_MAGIC;
    h.version = CSI_VERSION;
    h.hdr_len = sizeof(csi_frame_hdr_t);
    h.node_id = node_id;
    h.source = 0;
    h.sig_mode = p->sig_mode;
    h.mcs = p->mcs;
    h.cwb = p->cwb;
    h.stbc = p->stbc;
    h.first_word_invalid = p->first_word_invalid;
    h.gain_valid = 0;
    h.rssi_dbm = p->rssi;
    h.noise_floor_dbm = p->noise_floor;
    h.channel = p->channel;
    h.secondary_channel = p->secondary_channel;
    memcpy(h.src_mac, p->mac, sizeof(h.src_mac));
    h.csi_parts = (p->len >= 128 ? CSI_PART_LLTF : 0) | (p->len >= 256 ? CSI_PART_HTLTF : 0);
    h.csi_shift = 0;
    h.rx_seq = p->rx_seq;
    h.gain_comp = 1.0f;
    h.boot_id = boot_id;
    h.ts_us = (uint64_t)p->ts_us;
    h.seq = seq;
    h.n_values = p->len;
    memcpy(out, &h, sizeof(h));   /* the ESP32 and the PC are both little-endian */
    memcpy(out + sizeof(h), p->buf, p->len);
    return len;
}

static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

size_t csi_frame_line(char *out, size_t cap, const uint8_t *frame, size_t len)
{
    size_t prefix = sizeof(CSI_LINE_PREFIX) - 1;
    size_t need = prefix + 4 * ((len + 2) / 3) + 1;   /* + "\n" */
    if (need + 1 > cap) {
        return 0;
    }
    memcpy(out, CSI_LINE_PREFIX, prefix);
    char *o = out + prefix;
    for (size_t i = 0; i < len; i += 3) {
        uint32_t v = (uint32_t)frame[i] << 16;
        if (i + 1 < len) {
            v |= (uint32_t)frame[i + 1] << 8;
        }
        if (i + 2 < len) {
            v |= frame[i + 2];
        }
        *o++ = B64[(v >> 18) & 63];
        *o++ = B64[(v >> 12) & 63];
        *o++ = i + 1 < len ? B64[(v >> 6) & 63] : '=';
        *o++ = i + 2 < len ? B64[v & 63] : '=';
    }
    *o++ = '\n';
    *o = '\0';
    return need;
}
