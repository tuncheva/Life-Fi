/* Presence and people-count estimator, fed one 1 s CSI window at a time.
 *
 * Every packet's 52 amplitudes are divided by their mean (cancels AGC and
 * auto-scaling). Per window, each subcarrier's mean and variance are
 * compared with an empty-room calibration taken at boot:
 *   motion  mean over subcarriers of sqrt(var / empty var)    ~1 when empty
 *   active  share of subcarriers with var > K x empty var     ~0 when empty
 *   dev     1 - corr(mean profile, empty profile)             still people
 * Presence is a state machine over these. The count is a monotonic mapping
 * of the smoothed motion score, or the nearest level learned with `learn N`. */
#pragma once

#include <stdint.h>
#include "lifefi_config.h"

typedef struct {
    uint32_t n;                 /* packets in the window */
    float rate_hz;
    float rssi;
    float mean[LIFEFI_NSC];     /* normalised amplitude, ~1.0 */
    float var[LIFEFI_NSC];
} csi_window_t;

/* Loads learned count levels from NVS and starts the boot calibration. */
void estimator_init(void);

/* Feed one closed window; logs one line per call. */
void estimator_push(const csi_window_t *w);

/* Latest shown count: 0 empty, >= 1 people, -1 calibrating or uncertain. */
int estimator_people(void);

/* Features of the latest window (zeros until calibrated). */
typedef struct {
    float motion;       /* mean sqrt(var / empty var), ~1 when empty */
    float active;       /* share of subcarriers with var > K x empty var */
    float dev;          /* smoothed 1 - corr(profile, empty profile) */
    float score;        /* motion averaged over LIFEFI_SMOOTH_WINDOWS */
} estimator_features_t;

void estimator_features(estimator_features_t *out);

/* Thread-safe requests, executed at the next window. */
void estimator_request_calibration(void);
void estimator_request_learn(int count);
void estimator_request_forget(void);
void estimator_request_status(void);
