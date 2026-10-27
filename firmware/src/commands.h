/* Line commands typed into the serial monitor:
 *   cal       recalibrate the empty room
 *   learn N   record 30 s with N people moving, store it as count level N
 *   forget    clear the learned count levels
 *   status    print thresholds and learned levels
 *   wifi <ssid> <password>   save station credentials to flash and restart
 *   wifi clear               erase them (back to sniffer mode)
 *   help */
#pragma once

void commands_start(void);

/* Parse and run one typed line (modifies it in place). */
void commands_handle_line(char *line);
