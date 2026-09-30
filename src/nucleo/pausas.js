// Pausas del bot por conversación (cuando se deriva a una persona).
//
// POR QUÉ: si el dueño está respondiendo desde su celular, el bot no tiene que
// meterse. La pausa vence sola después de X minutos (configurable por empresa).
// Hoy vive en memoria: si reiniciás el programa, se borra. Más adelante va a
// una base de datos.

export function crearPausas(ahora = () => Date.now()) {
  const hasta = new Map();
  return {
    pausar(hiloId, minutos) {
      hasta.set(hiloId, ahora() + minutos * 60_000);
    },
    reanudar(hiloId) {
      hasta.delete(hiloId);
    },
    estaPausado(hiloId) {
      const fin = hasta.get(hiloId);
      if (!fin) return false;
      if (ahora() >= fin) {
        hasta.delete(hiloId);
        return false;
      }
      return true;
    },
  };
}
