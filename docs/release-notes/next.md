## Before you update

* **Sessions that were running while Astera was closed end once, on this update.** The background Host
  now proves it is yours before Astera or `astera` talks to it, so another account on a shared
  Windows machine cannot stand in for it. That changed how the two talk, and the Host from before the
  update cannot stay. Opening Astera after the update replaces it with the new one. If you use only
  the `astera` command and do not open Astera, run `astera host start --replace` once instead.
