Monitor and control your DEFA Power or eRange charger from Homey.

The app connects to DEFA's CloudCharge service, so it works wherever your
charger is — no local network setup required to get started.

WHAT YOU GET

- Live charging power, session energy and lifetime energy
- Charging status: plugged out, plugged in, charging, paused by the car or by
  the charger
- Start and stop charging
- Eco mode on/off, and "charge now" to override smart charging
- Restart the charger
- The charger appears in Homey Energy as an EV charger

FLOWS

Triggers for charging started and stopped, car plugged in and unplugged,
status changes, and errors appearing and clearing. Conditions for charging,
car connected, eco mode and error state. Actions to start and stop charging,
set eco mode, override smart charging, restart, and refresh.

CHARGING CURRENT

CloudCharge cannot set a current limit on these chargers. The charger's own
configurator can, so the app talks to it directly over your local network.

Turn on "Control the charging current locally" in the device settings and fill
in the charger's IP address and the PIN you use for its configurator. A
charging current slider appears, along with switches for Plug & Charge and
offline charging, and a flow card to set the current from an automation.

The slider is ranged from what your installation actually allows, read from the
charger. Only the current is changed — every other installation parameter is
read and written back untouched, and the app refuses to write if anything looks
wrong. This writes to the charger's commissioning settings, so use it for a few
changes a day, not for load balancing every minute.

REQUIREMENTS

- A DEFA Power or eRange charger connected to CloudCharge
- The mobile number your DEFA Power account uses
- For charging current control: the charger reachable on your local network,
  plus its configurator PIN

SIGNING IN

Pairing asks for your mobile number and sends a code by SMS.

CloudCharge allows one active session per app. If Homey uses the same app
session as your phone, they will keep signing each other out. In the app
settings you can choose which app session Homey occupies — pick the one you do
not use on your phone, and the two will coexist. The SMS always says DEFA
Power; that is expected.

The sign-in lives in the app settings and is shared by all your chargers. After
signing in again, devices come back on their own within a few minutes.

PLEASE NOTE

This is an unofficial, community-made app. It is not created by, affiliated
with, or endorsed by DEFA. It uses an undocumented interface and may stop
working without notice if DEFA changes their service.

Source code and issue tracker: https://github.com/torp93/homey-defa-power
