// Shader effects that work on GNOME Shell 50 and 51.
//
// GNOME 51 removed Shell.GLSLEffect (the shell's own GLSL effect class) and
// Clutter.ShaderEffect became the way to run a custom fragment shader: the
// shader is handed over as a Cogl.Snippet through the get_static_snippet vfunc
// and uniforms are set by name with set_uniform_float().
//
// GNOME 50 has no snippet API on Clutter.ShaderEffect (it only offers
// set_shader_source() plus the awkward variadic set_uniform()), so there the
// shell's GLSLEffect is still the better fit: the shader is added as a GLSL
// snippet in build_pipeline and uniforms are set through pipeline locations.
//
// Both paths expose the same small API to the effects that use them:
//
//   const MyEffect = GObject.registerClass(
//   class MyEffect extends makeShaderEffect('NotchNuxMyEffect', DECLARATIONS, CODE) {
//       setSomething(value) {
//           this.setUniform('something', 1, [value]);
//           this.queue_repaint();
//       }
//   });
//
// setUniform(name, count, values) sets a float uniform: `count` is the number
// of components (1 for a float, 2 for a vec2) and `values` holds them.
// `typeName` is the GType name of the base class; every effect needs its own,
// since GType names are unique per process.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

// Shell.GLSLEffect is simply gone on GNOME 51; the property is undefined
// there, which is exactly how we pick the implementation.
const HAS_SHELL_GLSL_EFFECT = typeof Shell.GLSLEffect === 'function';

export function makeShaderEffect(typeName, declarations, code) {
    if (HAS_SHELL_GLSL_EFFECT) {
        // GNOME 50: the shell's GLSLEffect.
        return GObject.registerClass({GTypeName: typeName},
        class ShaderEffect extends Shell.GLSLEffect {
            _init() {
                super._init();
                this._locations = new Map();
            }

            vfunc_build_pipeline() {
                this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, declarations, code, false);
            }

            setUniform(name, count, values) {
                let location = this._locations.get(name);
                if (location === undefined) {
                    location = this.get_uniform_location(name);
                    this._locations.set(name, location);
                }
                this.set_uniform_float(location, count, values);
            }
        });
    }

    // GNOME 51: Clutter.ShaderEffect with a static snippet.
    return GObject.registerClass({GTypeName: typeName},
    class ShaderEffect extends Clutter.ShaderEffect {
        vfunc_get_static_snippet() {
            return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, declarations, code);
        }

        setUniform(name, count, values) {
            this.set_uniform_float(name, count, values);
        }
    });
}
