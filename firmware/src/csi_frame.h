/* Raw CSI frame on the wire, firmware -> PC: the csi_frame_hdr_t v2 contract
 * of docs/plan/plan-v2.md §4.1, followed by the unmodified CSI bytes.
 * Little-endian, packed. The Python side is tools/csi_recorder.py (HDR). */
#pragma once

#include <stddef.h>
#include <stdint.h>
#include "csi_window.h"

#define CSI_MAGIC   0x31495343u   /* "CSI1" */
#define CSI_VERSION 2

#define CSI_PART_LLTF  0x01
#define CSI_PART_HTLTF 0x02

#pragma pack(push, 1)
typedef struct {
    uint32_t magic;
    uint16_t version;            /* CSI_VERSION */
    uint16_t hdr_len;            /* sizeof(csi_frame_hdr_t) */
    uint8_t  node_id;
    uint8_t  source;             /* 0 live, 1 replay */
    uint8_t  sig_mode;           /* 0 non-HT, 1 HT */
    uint8_t  mcs;
    uint8_t  cwb;                /* 0 = 20 MHz */
    uint8_t  stbc;
    uint8_t  first_word_invalid;
    uint8_t  gain_valid;         /* 0: no gain compensation; normalise per packet */
    uint8_t  agc_gain;           /* 0 until esp_csi_gain_ctrl is integrated */
    int8_t   fft_gain;
    int8_t   rssi_dbm;
    int8_t   noise_floor_dbm;
    uint8_t  channel;
    uint8_t  secondary_channel;
    uint8_t  src_mac[6];         /* transmitter (the router) */
    uint8_t  csi_parts;          /* CSI_PART_* present in data */
    uint8_t  csi_shift;          /* 0 = automatic scaling */
    uint16_t rx_seq;             /* 802.11 sequence number */
    float    gain_comp;          /* 1.0 while gain_valid = 0 */
    uint32_t boot_id;            /* random per boot */
    uint64_t ts_us;              /* esp_timer_get_time() */
    uint32_t seq;                /* UDP packet counter, per boot */
    uint16_t n_values;           /* int8 CSI values that follow */
} csi_frame_hdr_t;
#pragma pack(pop)

_Static_assert(sizeof(csi_frame_hdr_t) == 54, "csi_frame_hdr_t must stay 54 bytes");

#define CSI_FRAME_MAX (sizeof(csi_frame_hdr_t) + CSI_BUF_MAX)

/* Writes header + CSI bytes into out; returns the frame length, or 0 if
 * cap is too small. */
size_t csi_frame_build(uint8_t *out, size_t cap, const csi_packet_t *p, uint8_t node_id,
                       uint32_t boot_id, uint32_t seq);

/* Over USB serial a frame travels as one text line: CSI_LINE_PREFIX, the
 * frame in standard base64 (with padding), then "\n". */
#define CSI_LINE_PREFIX "@CSI "
#define CSI_LINE_MAX    (sizeof(CSI_LINE_PREFIX) + 4 * ((CSI_FRAME_MAX + 2) / 3) + 2)

/* Writes the NUL-terminated line into out; returns its length without the
 * NUL, or 0 if cap is too small. */
size_t csi_frame_line(char *out, size_t cap, const uint8_t *frame, size_t len);
