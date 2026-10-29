/* Raw CSI stream (csi_frame.h), two ways, both on demand:
 * - UDP: a PC sends "LFSUB" to UDP port LIFEFI_STREAM_PORT on the board at
 *   least every few seconds; every CSI packet goes back to that address.
 *   Needs station mode (an IP address) on the PC's network.
 * - USB serial: the serial command `usbstream`, repeated at least every few
 *   seconds, prints every CSI packet as a CSI_LINE_PREFIX base64 line.
 *   Works on any network, and in sniffer mode. */
#pragma once

#include <stddef.h>
#include "csi_window.h"

void stream_start(void);                 /* idempotent; call once connected */
void stream_poll(void);                  /* handle subscriptions; call often */
void stream_send(const csi_packet_t *p);
void stream_usb_keepalive(void);         /* USB lines for the next LIFEFI_STREAM_TIMEOUT_MS */
void stream_describe(char *buf, size_t len);
