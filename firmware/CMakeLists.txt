cmake_minimum_required(VERSION 3.16.0)
# Unused, and the xtensa GCC intermittently segfaults compiling esp_lcd_panel_rgb.c
set(EXCLUDE_COMPONENTS esp_lcd)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(lifefi-firmware)
