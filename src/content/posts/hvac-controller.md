---
title: "Embedded HVAC Controller"
date: 2026-01-15
excerpt: "Real-time dual-compressor HVAC control system with Arduino FreeRTOS and Python desktop GUI — thermal simulation, load balancing, and bidirectional serial communication."
summary: "A full-stack embedded systems project bridging firmware and desktop software: an Arduino Mega 2560 running FreeRTOS manages dual compressors, fan speed, and thermal simulation, while a PySide6/QML desktop application provides real-time monitoring, control, and data visualization over a custom JSON serial protocol."
category: embedded
featured: false
github: "https://github.com/rvxfahim/miniProject"
demo_video: "/diagrams/hvac-controller/demo.mp4"
technologies: ["C", "C++", "Python", "FreeRTOS", "Arduino", "PySide6", "Qt/QML", "PlatformIO"]
---

## The Idea

Most embedded systems projects stop at the firmware — a microcontroller doing its job in isolation, with maybe a few LEDs for feedback. I wanted to build something that felt like a real product: an embedded controller paired with a proper desktop application, communicating over a well-defined protocol. An HVAC system turned out to be the perfect domain — it has real-time constraints, multiple actuators, sensor feedback loops, and enough complexity to justify both a real-time operating system on the microcontroller and a rich GUI on the PC side.

The result is a dual-compressor HVAC controller that models room thermal dynamics, balances compressor wear through automatic load rotation, and exposes everything through a PySide6 desktop app with live charting and gauge visualization.

## System Architecture

The system is split cleanly across two platforms that communicate over USB serial at 9600 baud using a custom JSON protocol:

### Arduino Firmware (FreeRTOS / C++)

The Arduino Mega 2560 runs six concurrent FreeRTOS tasks, each handling a distinct responsibility:

| Task | Role |
|---|---|
| **Simulation** | Models room thermal dynamics — heat transfer through walls (thermal resistance 0.005 K/W), room heat capacity (1000 J/K), and cooling from compressors. Updates the internal temperature every cycle. |
| **Print** | Serializes sensor data (inside/outside temperature, compressor states, power draw) as JSON and transmits it over serial. |
| **Receive** | Listens for incoming JSON commands from the GUI and pushes them onto a FreeRTOS queue for thread-safe processing. |
| **Compressor Control** | Manages the dual-compressor system — initialization sequence (both compressors at 5000W total), steady-state mode (single compressor at 2500W), and a minimum 2-second off-time between cycles to prevent short-cycling. |
| **Load Balancing** | Alternates between compressor A and B at a configurable interval (default 15 seconds) to distribute mechanical wear evenly. |
| **Fan Speed** | Reads an analog input on pin A0 and maps it to PWM output on pin 4, providing variable-speed fan control. |

Tasks communicate through a FreeRTOS queue carrying JSON payloads, ensuring thread-safe data transfer between the simulation, control, and communication subsystems.

### Desktop GUI (Python / PySide6 / QML)

The desktop application is built with PySide6 and uses QML for declarative UI design across two pages:

- **Configuration Page** — Serial port auto-detection, baud rate selection (9600 / 115200 / 500000), and connect/disconnect controls. A screenshot of the serial port settings is displayed for reference.
- **Control Page** — A custom temperature gauge dial (with needle and shadow graphics rendered from PNG assets), a real-time line chart of inside temperature over time (powered by QtCharts), start/stop buttons, an outside-temperature spinbox (20–50 °C), a compressor switch-time spinbox (5–60 seconds), and red/green LED indicators showing the state of each compressor.

Two background threads manage serial I/O: a read thread continuously parses incoming JSON telemetry, and a send thread maintains a command queue with deduplication and timeout-based retry for reliable delivery.

### Communication Protocol

All communication between the GUI and Arduino uses JSON over serial, with a simple acknowledgment mechanism:

**GUI → Arduino commands:** `setT` (target temperature), `start` / `stop`, `outT` (outside temperature), `switchT` (compressor switch interval)

**Arduino → GUI telemetry:** `inT` (inside temperature), `outT`, `watt` (compressor power), `tm` (timestamp), `comA` / `comB` (compressor states), `ack` (command acknowledgment)

If an acknowledgment is not received within a configurable timeout, the command is retried — ensuring commands are not lost even over an unreliable serial link.

## Thermal Simulation Model

Rather than using arbitrary temperature changes, the firmware models actual heat transfer physics:

- **Wall thermal resistance:** 0.005 K/W — determines how quickly outside heat penetrates the room
- **Room heat capacity:** 1000 J/K — governs how much energy is needed to change the room temperature by 1 Kelvin
- **Room volume:** 20 m³ — sets the scale of the thermal mass

Each simulation tick computes the net heat flow (outside heat ingress minus compressor cooling power), divides by the heat capacity, and integrates to produce the new inside temperature. This means the system responds realistically — a higher outside temperature or lower compressor power produces slower cooling, and the room has thermal inertia that prevents instant temperature changes.

## Dual-Compressor Logic

The dual-compressor design mirrors real industrial HVAC systems:

1. **Initialization mode** — Both compressors run simultaneously at 5000W total cooling power to rapidly bring the room to the target temperature.
2. **Steady-state mode** — Once the target is reached, the system switches to a single compressor at 2500W to maintain temperature efficiently.
3. **Load balancing** — Every N seconds (configurable from 5–60 seconds via the GUI), the system alternates which compressor is active. This prevents one compressor from accumulating disproportionate runtime, extending the operational life of both units.
4. **Minimum off-time** — A 2-second delay is enforced before a compressor can restart, protecting the hardware from short-cycling damage.

## What I Learned

The biggest challenge was **reliable serial communication**. Early versions suffered from dropped commands and partial JSON payloads that crashed the parser. The solution was threefold: an acknowledgment mechanism with timeout-based retry for the send side, a dedicated read thread that buffers and validates complete JSON objects before processing, and a command queue that deduplicates repeated commands. Together, these made the serial link robust enough for continuous operation.

I also gained a deeper appreciation for FreeRTOS task design. Deciding what belongs in its own task versus what can be folded into an existing one is not obvious. The six-task split (simulation, print, receive, compressor control, load balancing, fan speed) emerged after several iterations — earlier versions tried to combine simulation with compressor control, but the timing constraints of the thermal model conflicted with the state-machine logic of the compressor. Separating them made each task simpler and the whole system more predictable.

## Running It Yourself

**Firmware:**
```bash
# Clone and open in PlatformIO
git clone https://github.com/rvxfahim/miniProject
cd miniProject
# Select the megaatmega2560 environment, build, and upload
```

**Desktop GUI:**
```bash
cd src
pip install PySide6 pyserial numba
python main.py
```

Connect an Arduino Mega 2560 via USB, select the port at 9600 baud in the GUI, and start controlling. If you don't have the hardware, the repo includes SimulIDE simulation files (`simulIDE_Arduino_Mega.sim1`) that let you run the circuit virtually.
