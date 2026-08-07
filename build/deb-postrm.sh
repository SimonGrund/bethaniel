#!/bin/sh
# Debian post-removal hook.
#
# This runs as root and non-interactively under `apt remove`, so it deliberately
# does NOT delete anything: the data lives in each user's ~/.config/Bethaniel,
# and a package script has no business walking /home to erase it. Print the
# path instead so the user can reclaim the space (models alone can exceed 20 GB).
#
# The in-app "Storage & data" screen is the supported way to clear this before
# uninstalling.

set -e

case "$1" in
  remove | purge)
    echo ""
    echo "Bethaniel has been removed."
    echo ""
    echo "Your downloaded AI models, manuscripts and settings were kept in:"
    echo "    \$HOME/.config/Bethaniel"
    echo ""
    echo "To reclaim that disk space (this cannot be undone), run as each user:"
    echo "    rm -rf \$HOME/.config/Bethaniel"
    echo ""
    ;;
esac

exit 0
