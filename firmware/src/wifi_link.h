/* Wi-Fi link that produces the CSI.
 *
 * Station mode (credentials in wifi_secrets.h): connect to the router and
 * ping the gateway at 100 Hz; every reply is a CSI sample.
 * Sniffer mode (no credentials, or connecting failed): lock onto the
 * strongest access point and take CSI from its beacons and traffic. */
#pragma once

#include <stddef.h>
#include "esp_err.h"

typedef enum { LINK_STATION, LINK_SNIFFER } link_mode_t;

/* Blocks until the CSI source is chosen (connected, or AP locked). */
esp_err_t wifi_link_start(void);

/* One-line description for the periodic health log. */
void wifi_link_describe(char *buf, size_t len);
