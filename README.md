# loxone-klf200-control

_This project is work in progress_.

This project provides a wrapper around the TCP-based Velux KLF-200 API and exposes basic functionality to control
products via dedicated http endpoints.
Those http endpoints can then be used inside the Loxone Config to integrate e.g. Velux roof lights into the system.

## Usage

In order to start the web service you need to supply the `hostname` and `password` of your Velux KLF-200 Interface.
For the hostname you might use the mdns `.local` address. The password is the same as the Wi-Fi password and can't be changed.

```console
Usage: loxone-klf200-control [options]

WebService wrapper around the Velux KL200 endpoints.

Options:
  -V, --version              output the version number
  -n, --hostname <hostname>  The hostname of the Velux KLF-200 interface.
  -p --password <password>   The password of the Velux KLF-200 interface (Identical to the WiFi password).
  -b --bind <port>           The port the http web service binds on! (default: 8080)
  -h, --help                 display help for command
```
