import { describe, it, expect } from 'vitest'
import { LINUX_TOOLS, WORKSPACE_PLATFORMS, cdpPortRef, linuxFamily, linuxInstallLine, workspaceSupported } from './platform'

describe('workspaceSupported', () => {
  it('is Windows, Linux and macOS, nothing else', () => {
    expect(WORKSPACE_PLATFORMS).toEqual(['win32', 'linux', 'darwin'])
    for (const p of ['win32', 'linux', 'darwin']) expect(workspaceSupported(p), p).toBe(true)
    for (const p of ['freebsd', 'aix', 'sunos', '']) expect(workspaceSupported(p), p).toBe(false)
  })
})

describe('linuxInstallLine', () => {
  const release = (id: string, like = ''): string => `NAME="X"\nID=${id}\n${like ? `ID_LIKE="${like}"\n` : ''}VERSION_ID="1"\n`

  it('names the distribution family by ID, then by ID_LIKE', () => {
    expect(linuxFamily(release('ubuntu', 'debian'))).toBe('apt')
    expect(linuxFamily(release('"fedora"'))).toBe('dnf')
    expect(linuxFamily(release('rocky', 'rhel centos fedora'))).toBe('dnf')
    expect(linuxFamily(release('manjaro', 'arch'))).toBe('pacman')
    expect(linuxFamily(release('opensuse-tumbleweed', 'opensuse suse'))).toBe('zypper')
    expect(linuxFamily(release('pop', 'ubuntu debian'))).toBe('apt')
    expect(linuxFamily(release('nixos'))).toBeNull()
    expect(linuxFamily('')).toBeNull()
  })

  it("installs only the missing tools, with each family's package names", () => {
    expect(linuxInstallLine(release('ubuntu', 'debian'), [...LINUX_TOOLS])).toBe('sudo apt-get install -y xvfb xdotool imagemagick')
    expect(linuxInstallLine(release('fedora'), ['Xvfb', 'import'])).toBe('sudo dnf install -y xorg-x11-server-Xvfb ImageMagick')
    expect(linuxInstallLine(release('arch'), ['Xvfb'])).toBe('sudo pacman -S --needed xorg-server-xvfb')
    expect(linuxInstallLine(release('opensuse-leap', 'suse opensuse'), ['xdotool'])).toBe('sudo zypper install -y xdotool')
  })

  it('gives a generic line when the distribution is unknown', () => {
    expect(linuxInstallLine(release('nixos'), ['xdotool'])).toBe(
      "install Xvfb, xdotool and ImageMagick (which provides import) with your distribution's package manager"
    )
  })
})

describe('cdpPortRef', () => {
  it('is cmd syntax on Windows and sh syntax elsewhere', () => {
    expect(cdpPortRef('win32')).toBe('%ASTERA_APP_CDP_PORT%')
    expect(cdpPortRef('linux')).toBe('$ASTERA_APP_CDP_PORT')
    expect(cdpPortRef('darwin')).toBe('$ASTERA_APP_CDP_PORT')
  })
})
