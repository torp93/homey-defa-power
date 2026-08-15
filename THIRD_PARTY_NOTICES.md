# Third-party notices

## Trademarks

"DEFA", "DEFA Power", "eRange" and "CloudCharge" are trademarks of DEFA AS.
This project is not created by, affiliated with, endorsed by, or supported by
DEFA. The names are used solely to describe which hardware and service the app
communicates with (nominative use).

## Reverse-engineered API

The app talks to the CloudCharge service (`prod.cloudcharge.se`) and to the
charger's local commissioning web interface. Neither has a public, documented
API. The endpoints, request shapes and behaviour were determined by observing
the official apps and the charger's own web UI. They may change or stop working
at any time without notice.

The developer tokens used to identify the client to CloudCharge are the same
values the official DEFA Power and CloudCharge mobile apps use. They are
included so the app can authenticate the way those apps do. They are not
secrets belonging to this project.

## Prior work

API mapping builds on **[Bebbssos/ha-defa-power](https://github.com/Bebbssos/ha-defa-power)**,
the Home Assistant integration for DEFA Power / eRange chargers. Thanks to that
project for charting the CloudCharge endpoints.

## Icons

Capability and app icons are original line-art drawn for this project.
