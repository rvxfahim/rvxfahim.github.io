---
title: "Self-Overwriting OTA Firmware for ESP32"
date: 2026-06-15
excerpt: "A custom over-the-air firmware update system that overwrites its own running flash partition from IRAM, eliminating the need for duplicate OTA partitions and maximizing application space."
category: "embedded"
featured: false
github: "https://github.com/rvxfahim/OTA_ESP"
technologies: ["C++", "ESP32", "PlatformIO", "FreeRTOS", "Python"]
---

## The Problem

Standard ESP32 OTA works by keeping two copies of the application -- `ota_0` and `ota_1` -- alongside a small `otadata` partition that tracks which slot is active. After downloading a new image into the inactive slot, the device flips the boot marker and reboots. It's a proven, safe design, but it burns roughly half your flash on redundancy. On a 4 MB ESP32, that means only about 1.8 MB of usable application space after reserving for the bootloader, NVS, and the two OTA partitions.

I wanted more. Could I reclaim that wasted space by having the firmware overwrite itself?

## The Approach

The core idea is straightforward: download a new firmware binary over WiFi, buffer it entirely in PSRAM, then execute a flash-writing routine that erases and rewrites the very partition the device is running from. Since you cannot fetch instructions from flash while the flash is being written, that routine must run entirely from internal RAM (IRAM). No secondary OTA partition, no `otadata` -- just a single ~4 MB `factory` partition and a carefully orchestrated self-destruct-and-replace sequence.

The flow breaks into four stages:

1. **Download** -- Connect to WiFi, fetch the new binary over HTTP, and buffer it in PSRAM via `ps_malloc()`.
2. **Teardown** -- Disconnect WiFi and stop the radio stack, park the second core in an IRAM-safe spin loop, suspend the FreeRTOS scheduler, and disable interrupts.
3. **IRAM flash routine** -- Copy the binary from PSRAM into a 4 KB DRAM buffer (the only memory accessible when the cache is off), disable the flash cache, erase and write one sector at a time using ESRAM silicon-ROM SPI functions, re-enable the cache, and repeat.
4. **Reboot** -- Configure the watchdog timer for an immediate system reset, booting into the freshly written firmware.

## Key Technical Challenges

**PSRAM cache coherency.** PSRAM shares the same MMU and cache hardware as the external flash. When I disable the flash cache to write, PSRAM becomes inaccessible too. The workaround is a `dram_buffer` -- a 4 KB array tagged with `DRAM_ATTR` that lives in internal SRAM. With the cache on, I copy one chunk from PSRAM into this buffer; with the cache off, I write from the buffer to flash; then I re-enable the cache and advance to the next chunk.

**Multi-core safety.** On a dual-core ESP32, both CPUs share the flash cache. If core 0 disabled the cache while core 1 tried to fetch an instruction from flash, the result would be an immediate crash. I use `esp_ipc_call()` to dispatch a parking function to the other core -- it enters a tight `while(true) {}` loop with interrupts disabled, all from an `IRAM_ATTR` function, ensuring it never touches flash.

**No-Serial progress reporting.** Inside the critical section, `Serial.print()` is unavailable because the HardwareSerial driver lives in flash. Every string constant also needs `DRAM_ATTR` to prevent the compiler from placing it in flash's RODATA segment. I use `ets_printf()` -- a bare-metal ROM printf -- for diagnostics, with format strings explicitly placed in DRAM.

**WDT-triggered reboot.** After the last sector is written, there is no return to `loop()`. I re-enable timer group 0's watchdog, configure it for a system reset with a 100-microsecond timeout, and spin. The watchdog fires, the RTC resets the chip, and the ESP32 boots from the beginning of the `app0` partition -- which now contains the new firmware.

## Supporting Tooling

Beyond the embedded work, I built a few Python tools to make development safer:

- **`serve_firmware.py`** -- a minimal HTTP server that hosts `test/firmware.bin` on port 8000, so the ESP32 has something to download.
- **`dry_run_flash.py`** -- a simulator that replays the chunked IRAM flash loop against a local binary, printing each cache-on/cache-off transition. Useful for debugging the control flow without touching hardware.
- **`verify_binary_header.py`** -- checks the magic byte (`0xE9`) of an ESP32 application image to confirm the binary is a valid app partition, not a bootloader or raw dump.

## Architecture Diagrams

These three diagrams document the self-overwriting OTA system from the high-level stage flow down to the cache-toggle sequence and memory layout.

### 1. Four-Stage System Flow
![Four Stage System Flow — Download, Teardown, IRAM Flash, Reboot](/diagrams/ota-esp/four_stage_system_flow.svg)
*The complete OTA lifecycle: Stage 1 downloads the new firmware into PSRAM via WiFi. Stage 2 tears down the system (WiFi off, core 1 parked in IRAM, scheduler suspended, interrupts disabled). Stage 3 runs the IRAM-resident flash routine — a cache-toggle loop that copies 4KB chunks from PSRAM through a DRAM staging buffer into flash via ROM SPI functions. Stage 4 triggers a watchdog-timed system reset into the new firmware.*

### 2. IRAM Flash Sequence
![IRAM Flash Sequence — cache toggle loop detail](/diagrams/ota-esp/iram_flash_sequence.svg)
*The critical section in detail: the cache enable/disable toggling, the PSRAM-to-DRAM copy, the ROM function calls (`esp_rom_spiflash_erase_sector` + `esp_rom_spiflash_write`), the core 1 parking mechanism, and why ROM functions are always available. This is the sequence that makes self-overwriting possible.*

### 3. Memory and Partition Layout
![Memory Layout — IRAM, DRAM, PSRAM, Flash, ROM](/diagrams/ota-esp/memory_partition_layout.svg)
*The ESP32 memory map annotating what lives where and why: the single factory partition (~3.94MB usable), the bootloader and NVS, the DRAM staging buffer, the PSRAM firmware buffer, and the mask ROM SPI flash functions. Includes a comparison with the standard dual-OTA partition layout to show the space savings.*

## What I Learned

This project was a deep dive into ESP32 architecture at a level I had not touched before. I learned how the ESP32's memory map works: the distinction between IRAM (internal RAM, execution-safe with cache off), DRAM (data RAM), and PSRAM (external, cache-dependent). I discovered that the ESP32 has silicon-ROM SPI flash functions (`esp_rom_spiflash_erase_sector`, `esp_rom_spiflash_write`) that are always accessible because they live in mask ROM, not in flash. I also learned the hard way that the ESP-IDF's safe OTA APIs exist for good reason -- managing cache coherency, cross-core interrupts, and watchdog timers at the register level is delicate work.

Would I use this in production? Yes, in a context where maximizing application space is critical and it is acceptable that a cosmic ray might hit during the update process, leaving the device in a bricked state that requires physical intervention. The standard dual-partition OTA is more robust, but if you need every last byte of flash for your application, this self-overwriting approach can reclaim that wasted space -- with the caveat that it is inherently riskier.
