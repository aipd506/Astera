// Which platforms the agent app workspace runs on, and what each one needs (Linux and macOS design,
// Decisions L1 and Refusal). Pure, and imports nothing from Node.

export const WORKSPACE_PLATFORMS = ['win32', 'linux', 'darwin'] as const

export function workspaceSupported(platform: string): boolean {
  return (WORKSPACE_PLATFORMS as readonly string[]).includes(platform)
}

/** The three programs the Linux desk runs (L1). */
export const LINUX_TOOLS = ['Xvfb', 'xdotool', 'import'] as const
export type LinuxTool = (typeof LINUX_TOOLS)[number]

export interface LinuxTools {
  missing: LinuxTool[]
  /** How to install what is missing on this distribution; '' when nothing is. */
  installLine: string
}

type Family = 'apt' | 'dnf' | 'pacman' | 'zypper'

const PACKAGES: Record<Family, Record<LinuxTool, string>> = {
  apt: { Xvfb: 'xvfb', xdotool: 'xdotool', import: 'imagemagick' },
  dnf: { Xvfb: 'xorg-x11-server-Xvfb', xdotool: 'xdotool', import: 'ImageMagick' },
  pacman: { Xvfb: 'xorg-server-xvfb', xdotool: 'xdotool', import: 'imagemagick' },
  zypper: { Xvfb: 'xorg-x11-server-Xvfb', xdotool: 'xdotool', import: 'ImageMagick' }
}

const INSTALL: Record<Family, string> = {
  apt: 'sudo apt-get install -y',
  dnf: 'sudo dnf install -y',
  pacman: 'sudo pacman -S --needed',
  zypper: 'sudo zypper install -y'
}

const FAMILY_OF: ReadonlyArray<readonly [RegExp, Family]> = [
  [/^(debian|ubuntu|linuxmint|pop|elementary|raspbian|kali)$/, 'apt'],
  [/^(fedora|rhel|centos|rocky|almalinux|ol|amzn)$/, 'dnf'],
  [/^(arch|manjaro|endeavouros)$/, 'pacman'],
  [/^(opensuse.*|sles|suse)$/, 'zypper']
]

const GENERIC = "install Xvfb, xdotool and ImageMagick (which provides import) with your distribution's package manager"

function osReleaseField(text: string, name: string): string {
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq < 0 || line.slice(0, eq).trim() !== name) continue
    return line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
  }
  return ''
}

/** The package manager family of an /etc/os-release text: its ID first, then each ID_LIKE. */
export function linuxFamily(osRelease: string): Family | null {
  const ids = [osReleaseField(osRelease, 'ID'), ...osReleaseField(osRelease, 'ID_LIKE').split(/\s+/)]
    .map((s) => s.toLowerCase())
    .filter((s) => s !== '')
  for (const id of ids) for (const [re, family] of FAMILY_OF) if (re.test(id)) return family
  return null
}

export function linuxInstallLine(osRelease: string, missing: readonly LinuxTool[]): string {
  const family = linuxFamily(osRelease)
  if (!family) return GENERIC
  const packages = [...new Set(missing.map((t) => PACKAGES[family][t]))]
  return `${INSTALL[family]} ${packages.join(' ')}`
}

/** How a launch command names the debugging port variable in the shell that runs it (R12). */
export function cdpPortRef(platform: string): string {
  return platform === 'win32' ? '%ASTERA_APP_CDP_PORT%' : '$ASTERA_APP_CDP_PORT'
}
