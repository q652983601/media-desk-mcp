// Immutable upstream source/asset baseline; works in an unpacked npm tarball too.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

export const upstreamCommit = '3a23cb899691c29238138c76deb200114ce1830c'
const expected = {
  "assets/aurora.jpg": "aa8f563b7a245aa7241e4e7f35c8f23678f68ed2aa5a738087c43df8487ac8c9",
  "assets/blush.jpg": "b4bd9c4369c0b56b71cf4a9951a48a7f8470ae26a2f2daac4d9233eefb46ea69",
  "assets/collage.jpg": "092507511c917d640ca807146bfb5164a770ea06a0c874d10ea3b818ccf40716",
  "assets/dunes.jpg": "6c2a3eaeb1928a966c585039e70fa933d01f347ec5686ab48808cb2e5a15a2f4",
  "assets/emboss-en.jpg": "9807fb1e56b49008ae0424757f89636e12208b533d8c0a045a757c6ce0243a10",
  "assets/emboss.jpg": "3635c0fd322fd2ab161d5b75732eb7f5dd98c9d0981d2f0b9f90288a9a43bc77",
  "assets/facade.jpg": "1149f437774e2ad1b4d3a314de20fc4154f3ccb0ca213f1ffaf99235ee5b251a",
  "assets/hills.jpg": "e4239567ecf2b908fbfc8a0aef3cccbeba94c261caf244308b72f5b655da686a",
  "assets/ink.jpg": "6c9e1853ca0384a6b99977f24c523fd5f809cb7999b4d7eab0ee282ab5d3d624",
  "assets/night.jpg": "8dc4a2c4e60f3ad1d31737807a7aa990521fddf8a70b6f2d15328259d172e2e6",
  "assets/poster-en.jpg": "22b3b56912b6c9500122088f70df98df32ec5aa2cb06f2063ba3b0d90b243cb3",
  "assets/poster.jpg": "cba34689a057f890ed788511843b6471ce964670b382d5ce2daa3aaf03986bea",
  "assets/riso.jpg": "c55611efb7a9d670fa9d6eb6d071bcce7219c6f9671f825c3d4eec0e30fc4d5e",
  "assets/sea.jpg": "f8d9cb4fc6a6f4179296e8d3301e74563ea193ea473197f5d3d2d544d926b3eb",
  "assets/stairs.jpg": "803a59524601764915dbf2c93ab70c884a56ee89c4a4b8a607c06be905c734db",
  "assets/still.jpg": "872d3ff9fa5a1e8625fb3e8da97746524668b96575f2ae0a1f51f4ffafe70dac",
  "assets/topo.jpg": "02ca2aec872ab49758eb2c76b072aed374371f9d795fa10d778dfd4eca777a2c",
  "assets/v-aurora-poster.jpg": "059f09cf680dda7f3d0f1b1d6243b7ed9390dbb6bf40d31ab1c214839eacc4b7",
  "assets/v-aurora.mp4": "545dfc14c9ce3dd8473673088719214a0022416283ad9be37af1bfa35a80e2fc",
  "assets/v-bus-poster.jpg": "8bb4612c5905b0076b803b71d543b75e4bc754424461f2b6f183c55a867f6ea8",
  "assets/v-bus.mp4": "1d722e34de5f5a4159ed896f89a42697f15c5e75e33ab25f50652e020c32f75e",
  "assets/v-ink-poster.jpg": "73032b83bbd2b0f31d5c8bfde32471bfb308fffcfca27cba6a6685cdcfcb01e8",
  "assets/v-ink.mp4": "4818170bc51cbf6eeafffcd915854044132aa5d3db6ddd9763cbd93c738b6f02",
  "assets/v-tide-poster.jpg": "9ff147900d73607663a3047da575c5bd8e98b53bbb1113144ece22007377efc0",
  "assets/v-tide.mp4": "a90fd98978b70b7efffbe78f6fb1b8870fb7a02b1b5e2e28005130339dc1ee7d",
  "client/canvas.jsx": "7e1f4a9f7bcb16d3e9bda34f851533251013a530a76b6fdddd0e3e54accb0198",
  "client/card.jsx": "43a774a4993a26636cd558e6f26b123b734721cc3b53e26879195d938b107e69",
  "client/chat.jsx": "a46f1de29a0a1f2e58281b88edde6ea90e6d20a820a6e624f99e0f474dc587ab",
  "client/connect.jsx": "57919a812724a887a6bef516c22ee225b8f7d36ab4068a0f153f48fe9fa3dd6b",
  "client/content.jsx": "d125e96ff7619eb88de312e249e5edbbd36f5633c6d49494b2c44b561ec1a0d5",
  "client/cover.js": "ae26e978ee322640c39e3bf354bc3ef599ba0fa0ec1c0ac3bab2642ef32dcabd",
  "client/desk.js": "6354e3cec4cade3b3e8632c4720c4dd6267c8fd73a8766995fda8e97a4290c72",
  "client/en/core.js": "3d24e2ca355e926a51aeeae3e45ae12024f514de222d8a536625988c774bf0b2",
  "client/en/index.js": "ddf9e1dd06d7026fd340e1e66d268e246e2829b13370fe8f6031bd87bd8d2853",
  "client/en/pages.js": "11126c0169d48513c330889c0b1f8037ae3cd0291fa8f2b6141d893c66f024fd",
  "client/en/studio.js": "e4505df2255c2c25406bc3d258e6d392503ff1fd41695987e33ef13775ae1a35",
  "client/i18n.js": "9474ae3632051f4bcdd8d5c8894af00e5279b90a6d6cad499023a46f96b10213",
  "client/index.jsx": "1b89d8b8a371a93fa29e2b1d2dba3bd4232ccd291c7b6b923518f6c4f98f8ca9",
  "client/insights.jsx": "570b1964f33155f98d05f293d6570c2209b8d38e72dab611cb7acccd7647a538",
  "client/layout.js": "2e04f1632a060fee0065692cd05637f50d2a56ab350986396b401a5d92a15428",
  "client/modelpick.jsx": "6e777f73f882e8ac8e4621a15704eea7c85329861dde83f70ab1558d813c6684",
  "client/related.js": "98850ff7b028d05f38f550e08779004c68391c99aff3fa4d36e7dd094769d3db",
  "client/schedule.jsx": "0c266665435e4cfed8c127d13e4699a3d20491037202973944d33fd12b437ea2",
  "client/settings.jsx": "dbb1aed29d38115a28a2943f404df1358133d85fc34b1e85710eea9dedc5af7a",
  "client/stamps.jsx": "dda7e971a3f99ea999caa4b73ed14083b4a4ce1d6b35a11c76bd59f4af8c67cf",
  "client/studio.jsx": "2e1937737594bf3c56d0c857735df06e05c08bd6958db4294f093c4d69dc953f",
  "client/style.jsx": "89e44486dca1d37866ce001e2bfd4221562fd5a8cfa933e9991cdd35f6e3df9e",
  "client/styles.css": "9865d003e948cdde5d986db7c0d891a5e1db3eac6e4cce742773c403a526bf64",
  "client/ui.jsx": "5a05a72f9effad64b51a9a9fce71530cd7ced7087f0c9084e57def7a6ea1dafa",
  "client/util.js": "d6f4782d137fc5b7cd9b9c61b6a62648993d9884a573b8bd935473d3141c7fa7",
  "client/version.js": "d8dd2c4ded0579f46db042142f4b4815259631685cc45bb394a4329992833e20"
}
const root = fileURLToPath(new URL('../', import.meta.url))
const failures = []
for (const [path, hash] of Object.entries(expected)) {
  try {
    const actual = createHash('sha256').update(readFileSync(join(root, path))).digest('hex')
    if (actual !== hash) failures.push(path + ': changed')
  } catch { failures.push(path + ': missing') }
}
function visit(directory) {
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = directory + '/' + entry.name
    if (entry.isDirectory()) visit(path)
    else if (!(path in expected)) failures.push(path + ': added')
  }
}
for (const directory of ['client', 'assets']) visit(directory)
if (failures.length) {
  console.error('Upstream frontend integrity failed:\n' + failures.join('\n'))
  process.exitCode = 1
} else {
  console.log('Verified ' + Object.keys(expected).length + ' unchanged upstream frontend/asset files at ' + upstreamCommit)
}
